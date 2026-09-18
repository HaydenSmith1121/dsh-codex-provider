/**
 * Error type for this provider.
 *
 * The harness routes on `code`, never on message text, so every failure this
 * plugin raises carries a stable provider-neutral code and the structured
 * provider facts a caller may act on (HTTP status, retry-after).
 *
 * @module dsh-codex-provider/llm-error
 */

/** Base class for harness errors, mirrored here so the plugin stays dependency-light. */
class HarnessError extends Error {
  /**
   * @param message - human-readable summary.
   * @param code - stable machine-routable code.
   * @param options - standard `cause` chaining.
   */
  constructor(message, code, options) {
    super(message, options)
    this.code = code
    this.name = this.constructor.name
  }
}

/**
 * Typed failure carrying the provider facts the harness reads.
 *
 * Codes used by this plugin:
 * - `MISSING_CREDENTIAL` — no readable Codex session.
 * - `AUTH` — the backend rejected the credential.
 * - `RATE_LIMIT` — throttled; `providerRetryAfterMs` carries the reset delay.
 * - `QUOTA` — the subscription's usage allowance is exhausted.
 * - `CONTEXT_WINDOW_EXCEEDED` — the request exceeded the model's window.
 * - `UNKNOWN_MODEL` — the backend does not serve the requested model.
 * - `UNSUPPORTED_CONTENT` — content the route cannot carry, e.g. images.
 * - `UNSUPPORTED_OPTION` — a request control this route cannot honour.
 * - `UNSUPPORTED_REASONING_EFFORT` — an effort the model does not offer.
 * - `TIMEOUT`, `TRANSPORT`, `PROXY_REJECTED`, `ABORTED`, `EMPTY_RESPONSE`.
 */
export class LlmError extends HarnessError {
  /**
   * @param message - human-readable failure summary.
   * @param code - stable provider-neutral machine code.
   * @param options - cause plus validated serializable provider facts.
   */
  constructor(message, code, options = {}) {
    super(message, code, options)
    this.failure = {
      message,
      code,
      ...(options.status !== undefined ? { status: options.status } : {}),
      ...(options.providerRetryAfterMs !== undefined ? { providerRetryAfterMs: options.providerRetryAfterMs } : {}),
    }
  }
}

/**
 * Recognize provider wording that identifies an exhausted subscription
 * allowance rather than a transient request-rate limit.
 *
 * The Codex backend reports both as HTTP 429, so the status alone cannot
 * distinguish them; `usage_limit_reached` is the terminal one, and treating it
 * as retryable would burn attempts against an allowance that resets hours away.
 * @param detail - provider error type, code, and message text.
 * @returns true only for terminal quota wording.
 */
export function isQuotaExceeded(detail) {
  return /usage_limit_reached|quota|insufficient_quota|balance|billing|credit/i.test(detail)
}

/**
 * Recognize context-window overflow wording.
 * @param detail - provider error type, code, and message text.
 * @returns true when the detail identifies an over-long request.
 */
export function isContextWindowExceeded(detail) {
  return /context_length_exceeded|context window|maximum context|too many tokens|string too long/i.test(detail)
}
