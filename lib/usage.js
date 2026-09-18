/**
 * Subscription usage surface.
 *
 * The Codex backend reports the account's rate-limit windows on a dedicated
 * endpoint. This service exposes them to the client half so the session input
 * area can show how much of the allowance remains — the same affordance other
 * subscription-backed providers in this harness offer.
 *
 * The endpoint is not part of the Responses API and is not documented for
 * third-party use, so every parse is defensive: an unexpected shape degrades to
 * "unknown" rather than throwing into the UI.
 *
 * @module dsh-codex-provider/usage
 */
import { Service } from '@deepseek-ai/cordis'
import { codexRequest } from './transport.js'

/**
 * Path the backend reports rate-limit windows on.
 *
 * Taken from the Codex CLI binary, which references `/api/codex/usage`. This is
 * **relative to the host root**, not to `/backend-api/codex`, so the service
 * resolves it against the origin rather than the configured API base path.
 *
 * The path could not be confirmed with a live request: every attempt returned a
 * uniform 403 HTML page from Cloudflare for this client fingerprint, including
 * paths that cannot exist. It is therefore still an assumption — but a
 * low-risk one, because `read()` returns undefined on any non-200 and usage is
 * decorative, so a wrong path costs a missing pill rather than a broken turn.
 */
export const USAGE_PATH = '/api/codex/usage'

/**
 * Normalize one rate-limit window.
 *
 * Field names and units follow the app-server protocol schema
 * (`RateLimitWindow`), which is the authoritative contract: camelCase
 * `usedPercent`, and `resetsAt` as **Unix seconds**, not an ISO string.
 * @param raw - the backend's window object.
 * @returns the normalized window, or undefined when unusable.
 */
export function normalizeWindow(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const used = Number.isFinite(raw.usedPercent) ? raw.usedPercent : undefined
  // `resetsAt` is int64 seconds; convert once here so consumers get one unit.
  const resetsAt = Number.isFinite(raw.resetsAt) && raw.resetsAt > 0
    ? new Date(raw.resetsAt * 1000).toISOString()
    : undefined
  const windowMinutes = Number.isFinite(raw.windowDurationMins) ? raw.windowDurationMins : undefined
  if (used === undefined && resetsAt === undefined) return undefined
  return {
    ...(used !== undefined ? { usedPercent: used } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(windowMinutes !== undefined ? { windowMinutes } : {}),
  }
}

/**
 * Normalize one rate-limit bucket.
 *
 * A `RateLimitSnapshot` carries the two windows plus the account's plan and the
 * backend's own reason for refusing usage — the last of which is what lets the
 * UI say *why* the allowance is gone rather than only that it is.
 * @param snapshot - one `RateLimitSnapshot`.
 * @returns the normalized bucket, or undefined when it holds no windows.
 */
export function normalizeSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return undefined
  const windows = {}
  for (const key of ['primary', 'secondary']) {
    const window = normalizeWindow(snapshot[key])
    if (window !== undefined) windows[key] = window
  }
  if (Object.keys(windows).length === 0) return undefined

  const credits = snapshot.credits
  return {
    windows,
    ...(typeof snapshot.planType === 'string' ? { planType: snapshot.planType } : {}),
    ...(typeof snapshot.limitId === 'string' && snapshot.limitId.length > 0 ? { limitId: snapshot.limitId } : {}),
    ...(typeof snapshot.rateLimitReachedType === 'string' ? { reachedType: snapshot.rateLimitReachedType } : {}),
    // `unlimited` is the case where percentages are meaningless; surfacing it
    // keeps a consumer from rendering a meter for an uncapped account.
    ...(credits !== null && typeof credits === 'object' && credits.unlimited === true ? { unlimited: true } : {}),
    ...(credits !== null && typeof credits === 'object' && typeof credits.balance === 'string'
      ? { creditBalance: credits.balance }
      : {}),
  }
}

/**
 * Normalize the whole `GetAccountRateLimitsResponse` payload.
 *
 * The response carries a single backward-compatible `rateLimits` bucket plus a
 * multi-bucket `rateLimitsByLimitId` view. The multi-bucket view is preferred
 * when present, because the single view mirrors only the historical payload and
 * can omit a metered bucket the account actually has.
 *
 * @param payload - parsed response body.
 * @returns the normalized usage, or undefined when no bucket was usable.
 */
export function normalizeUsage(payload) {
  if (payload === null || typeof payload !== 'object') return undefined

  const buckets = {}
  const byId = payload.rateLimitsByLimitId
  if (byId !== null && typeof byId === 'object') {
    for (const [id, snapshot] of Object.entries(byId)) {
      const normalized = normalizeSnapshot(snapshot)
      if (normalized !== undefined) buckets[id] = { limitId: id, ...normalized }
    }
  }
  if (Object.keys(buckets).length === 0) {
    const single = normalizeSnapshot(payload.rateLimits)
    if (single !== undefined) buckets.default = { limitId: single.limitId ?? 'codex', ...single }
  }
  if (Object.keys(buckets).length === 0) return undefined

  // Plan type lives on the bucket, but the top level is the useful summary.
  const planType = Object.values(buckets).find((b) => typeof b.planType === 'string')?.planType

  return {
    buckets,
    // Retained for consumers that only want the account's headline window.
    windows: buckets[Object.keys(buckets)[0]].windows,
    ...(planType !== undefined ? { planType } : {}),
    ...(payload.ordinaryUsageAllowed === false ? { exhausted: true } : {}),
    ...(typeof payload.accountId === 'string' ? { accountId: payload.accountId } : {}),
  }
}

/**
 * Host service backing the client's usage pill.
 *
 * Reads through the same credential and transport as the adapter, so a
 * rotation is shared and no second credential path exists.
 */
export class UsageService extends Service {
  #options

  /**
   * @param ctx - the owning context.
   * @param options - wiring.
   * @param options.baseURL - backend origin.
   * @param options.resolveCredential - supplies the token and account id.
   */
  constructor(ctx, options) {
    super(ctx, 'codexUsage')
    this.#options = options
  }

  /**
   * Read the subscription's current rate-limit windows.
   * @returns normalized usage, or undefined when the backend does not report it.
   */
  async read() {
    let credential
    try {
      credential = await this.#options.resolveCredential()
    } catch {
      return undefined
    }
    try {
      const response = await codexRequest({
        // `USAGE_PATH` is host-root-relative, while the configured baseURL ends
        // in `/backend-api/codex`. Resolving against the origin keeps the path
        // from being doubled, which is what a naive join would produce.
        baseURL: originOf(this.#options.baseURL()),
        path: USAGE_PATH,
        method: 'GET',
        accessToken: credential.accessToken,
        accountId: credential.accountId,
        timeoutMs: 15_000,
      })
      if (response.status !== 200) return undefined
      return normalizeUsage(JSON.parse(response.body))
    } catch {
      // Usage is decorative: a failure here must never surface as a turn error.
      return undefined
    }
  }
}

/**
 * Reduce a configured API base URL to its origin.
 * @param baseURL - configured base URL.
 * @returns `scheme://host[:port]`, or the input unchanged when unparseable.
 */
export function originOf(baseURL) {
  try {
    return new URL(baseURL).origin
  } catch {
    return baseURL
  }
}

export default UsageService
