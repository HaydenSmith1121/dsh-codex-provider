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

/** Path the backend reports rate-limit windows on. */
export const USAGE_PATH = '/usage'

/**
 * Normalize one rate-limit window.
 * @param raw - the backend's window object.
 * @returns the normalized window, or undefined when unusable.
 */
export function normalizeWindow(raw) {
  if (raw === null || typeof raw !== 'object') return undefined
  const used = typeof raw.used_percent === 'number' && Number.isFinite(raw.used_percent) ? raw.used_percent : undefined
  const resetsAt = typeof raw.resets_at === 'string' && Number.isFinite(Date.parse(raw.resets_at)) ? raw.resets_at : undefined
  if (used === undefined && resetsAt === undefined) return undefined
  return {
    ...(used !== undefined ? { usedPercent: used } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(typeof raw.window_minutes === 'number' ? { windowMinutes: raw.window_minutes } : {}),
  }
}

/**
 * Normalize the whole usage payload.
 *
 * The endpoint's exact shape is not contractual, so this reads the known
 * window names and falls back to scanning for anything window-shaped.
 * @param payload - parsed response body.
 * @returns normalized windows, or undefined when nothing usable was present.
 */
export function normalizeUsage(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  const windows = {}
  for (const key of ['primary', 'secondary', 'rolling', 'weekly', 'daily']) {
    const window = normalizeWindow(payload[key])
    if (window !== undefined) windows[key] = window
  }
  if (Object.keys(windows).length === 0) {
    const rate = payload.rate_limits ?? payload.rateLimits
    if (rate !== null && typeof rate === 'object') {
      for (const key of Object.keys(rate)) {
        const window = normalizeWindow(rate[key])
        if (window !== undefined) windows[key] = window
      }
    }
  }
  if (Object.keys(windows).length === 0) return undefined
  return {
    windows,
    ...(typeof payload.plan_type === 'string' ? { planType: payload.plan_type } : {}),
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
        baseURL: this.#options.baseURL(),
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

export default UsageService
