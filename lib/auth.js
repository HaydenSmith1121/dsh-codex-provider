/**
 * Codex credential resolution against `~/.codex/auth.json`.
 *
 * The Codex CLI authenticates with a ChatGPT subscription OAuth session, not an
 * API key, so the harness cannot reach these models through a generic
 * OpenAI-compatible route. This module reads that session — and only reads it.
 *
 * ## Read-only by contract
 *
 * `~/.codex/auth.json` belongs to the Codex CLI. Writing a refreshed token back
 * would make this plugin a second writer of another product's credential file,
 * so a failure here could break the user's Codex installation. Every refresh
 * therefore stays in memory: the rotated token serves this process until it
 * exits, and the file on disk is left exactly as found.
 *
 * ## Refresh
 *
 * The access token is a short-lived JWT. Its `exp` claim is the only reliable
 * expiry signal, and it is read from the token itself rather than from the
 * file's `last_refresh`, which records when a refresh last happened rather than
 * whether the result is still valid.
 *
 * @module dsh-codex-provider/auth
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** OAuth client the Codex CLI signs in with; the refresh endpoint pins this audience. */
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/** Token endpoint for the ChatGPT auth provider. */
export const TOKEN_URL = 'https://auth.openai.com/oauth/token'
/** Refresh this long before the true expiry, so a request cannot start on a token that dies in flight. */
export const EXPIRY_SKEW_MS = 120_000

/** Raised when no usable Codex credential can be produced. */
export class CredentialError extends Error {
  /**
   * @param message - human-readable diagnosis naming the file to fix.
   */
  constructor(message) {
    super(message)
    this.name = 'CredentialError'
  }
}

/**
 * Decode one JWT payload without verifying its signature.
 *
 * The token is used against the issuer that minted it, which verifies the
 * signature itself, and `exp` is read only to schedule a refresh. No trust
 * decision rests on this decode.
 * @param token - compact JWS.
 * @returns the decoded payload, or undefined when it is not a readable JWT.
 */
export function decodeJwtPayload(token) {
  const parts = typeof token === 'string' ? token.split('.') : []
  if (parts.length !== 3) return undefined
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const parsed = JSON.parse(json)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Read an access token's expiry as epoch milliseconds.
 * @param token - the access token.
 * @returns expiry in ms, or undefined when the token carries no usable `exp`.
 */
export function tokenExpiryMs(token) {
  const exp = decodeJwtPayload(token)?.exp
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : undefined
}

/**
 * Extract the ChatGPT account id from a Codex session.
 *
 * The id is required on every request as `chatgpt-account-id`. It is stored
 * beside the tokens and also embedded in the id_token's auth claim; the stored
 * field is authoritative when present.
 * @param session - the parsed auth document.
 * @returns the account id, or undefined when the session does not carry one.
 */
export function accountIdOf(session) {
  const direct = session?.tokens?.account_id
  if (typeof direct === 'string' && direct.length > 0) return direct
  const claim = decodeJwtPayload(session?.tokens?.id_token)?.['https://api.openai.com/auth']
  const nested = claim?.chatgpt_account_id
  return typeof nested === 'string' && nested.length > 0 ? nested : undefined
}

/**
 * Locate the Codex auth document.
 * @param env - environment consulted for `CODEX_HOME`.
 * @returns absolute path to the auth document.
 */
export function authPath(env = process.env) {
  const home = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.length > 0 ? env.CODEX_HOME : join(homedir(), '.codex')
  return join(home, 'auth.json')
}

/**
 * Read and validate the Codex session document.
 * @param path - auth document path.
 * @returns the parsed session.
 * @throws CredentialError when the file is absent, unreadable, or not a Codex session.
 */
export async function readSession(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CredentialError(
        `dsh-codex-provider: no Codex session at ${path}. Run \`codex login\` to sign in with a ChatGPT account, or point CODEX_HOME at an existing Codex home.`,
      )
    }
    throw new CredentialError(`dsh-codex-provider: cannot read the Codex session at ${path} (${error?.message ?? String(error)})`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new CredentialError(`dsh-codex-provider: the Codex session at ${path} is not valid JSON (${error?.message ?? String(error)})`)
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new CredentialError(`dsh-codex-provider: the Codex session at ${path} is not a JSON object`)
  }
  const accessToken = parsed?.tokens?.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new CredentialError(
      `dsh-codex-provider: the Codex session at ${path} carries no access token. It is probably an API-key login; sign in with \`codex login\` to use a ChatGPT subscription.`,
    )
  }
  const accountId = accountIdOf(parsed)
  if (accountId === undefined) {
    throw new CredentialError(`dsh-codex-provider: the Codex session at ${path} carries no ChatGPT account id; sign in again with \`codex login\`.`)
  }
  return parsed
}

/**
 * Exchange a refresh token for a fresh access token.
 *
 * Sends the same request the Codex CLI's own refresh uses, including the
 * public client id, so no user-supplied secret is involved.
 * @param refreshToken - the rotating refresh token from the session.
 * @param fetchImpl - fetch implementation; injectable for tests.
 * @returns the new access, refresh, and id tokens as the endpoint reported them.
 * @throws CredentialError when the endpoint rejects the refresh or is unreachable.
 */
export async function refreshTokens(refreshToken, fetchImpl = fetch) {
  let response
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        scope: 'openid profile email',
      }),
    })
  } catch (error) {
    throw new CredentialError(`dsh-codex-provider: cannot reach the token endpoint (${error?.message ?? String(error)})`)
  }
  const text = await response.text()
  if (!response.ok) {
    // 400/401 here means the refresh token itself is dead; the user must re-login.
    throw new CredentialError(
      `dsh-codex-provider: the Codex refresh token was rejected (HTTP ${response.status}). Run \`codex login\` again. ${text.slice(0, 300)}`,
    )
  }
  let body
  try {
    body = JSON.parse(text)
  } catch (error) {
    throw new CredentialError(`dsh-codex-provider: the token endpoint returned non-JSON (${error?.message ?? String(error)})`)
  }
  const accessToken = body?.access_token
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    throw new CredentialError('dsh-codex-provider: the token endpoint returned no access token')
  }
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token.length > 0 ? body.refresh_token : refreshToken,
    idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
    expiresIn: typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) ? body.expires_in : undefined,
  }
}

/**
 * Resolve a usable Codex credential, refreshing in memory when the access token
 * is expired or about to be.
 *
 * The rotated token is cached for this process only; nothing is written back to
 * the Codex CLI's file.
 */
export class CodexCredentialSource {
  #fetchImpl
  #now
  #path
  #cached
  #refreshing

  /**
   * @param options - optional injection seams.
   * @param options.fetchImpl - fetch implementation for the token endpoint.
   * @param options.now - clock, in epoch milliseconds.
   * @param options.path - auth document path; defaults to the Codex home.
   */
  constructor(options = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.#now = options.now ?? (() => Date.now())
    this.#path = options.path ?? authPath()
  }

  /** Absolute path of the session file this source reads. */
  get path() {
    return this.#path
  }

  /**
   * Return a credential usable right now, refreshing first when necessary.
   * @returns the access token and the account id to send with it.
   * @throws CredentialError when no usable credential can be produced.
   */
  async resolve() {
    const now = this.#now()
    if (this.#cached !== undefined && this.#cached.expiresAt - EXPIRY_SKEW_MS > now) {
      return { accessToken: this.#cached.accessToken, accountId: this.#cached.accountId }
    }
    // Collapse concurrent refreshes: one in-flight rotation, everyone awaits it.
    this.#refreshing ??= this.#load(now).finally(() => {
      this.#refreshing = undefined
    })
    return this.#refreshing
  }

  /**
   * Read the session and refresh only when its access token is unusable.
   * @param now - current epoch milliseconds.
   * @returns the resolved credential.
   */
  async #load(now) {
    const session = await readSession(this.#path)
    const accessToken = session.tokens.access_token
    const accountId = accountIdOf(session)
    const expiresAt = tokenExpiryMs(accessToken)

    if (expiresAt !== undefined && expiresAt - EXPIRY_SKEW_MS > now) {
      this.#cached = { accessToken, accountId, expiresAt }
      return { accessToken, accountId }
    }

    const refreshToken = session.tokens.refresh_token
    if (typeof refreshToken !== 'string' || refreshToken.length === 0) {
      // No way to renew. If the token has no `exp` at all, let the request try it
      // rather than refusing outright — the issuer is the real authority.
      if (expiresAt === undefined) {
        this.#cached = { accessToken, accountId, expiresAt: now }
        return { accessToken, accountId }
      }
      throw new CredentialError(
        `dsh-codex-provider: the Codex access token expired and the session carries no refresh token. Run \`codex login\` again.`,
      )
    }

    const refreshed = await refreshTokens(refreshToken, this.#fetchImpl)
    const nextExpiry = refreshed.expiresIn !== undefined
      ? now + refreshed.expiresIn * 1000
      : tokenExpiryMs(refreshed.accessToken) ?? now + 3_600_000
    this.#cached = { accessToken: refreshed.accessToken, accountId, expiresAt: nextExpiry }
    return { accessToken: refreshed.accessToken, accountId }
  }

  /**
   * Drop the cached token, forcing the next resolve to re-read the session.
   * Called after an authentication rejection so one stale token cannot pin a
   * whole session to 401s.
   */
  invalidate() {
    this.#cached = undefined
  }
}
