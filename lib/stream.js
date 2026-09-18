/**
 * Turn a Responses SSE event stream into harness `StreamChunk`s.
 *
 * The harness consumes an interleaved, index-addressed chunk protocol:
 * `block-start` opens a block, deltas append to it, `block-end` carries the
 * assembled result, and exactly one `finish` terminates the stream.
 *
 * The Responses API streams something structurally different — a flat sequence
 * of typed events, where each output item has its own `output_index` and text
 * arrives as `response.output_text.delta` with a `content_index` *within* that
 * item. Reasoning arrives on a separate channel (`response.reasoning_summary_*`)
 * and must become its own block so the harness can render it distinctly.
 *
 * The mapping therefore maintains one harness block per (item, content) pair
 * and assigns harness indexes itself, because reasoning-summary events and text
 * events share an item index but are different blocks.
 *
 * ## Tolerance for event-name drift
 *
 * The backend's event names could not be fully confirmed against a successful
 * live turn while this plugin was written (the subscription was rate-limited
 * throughout), and the compiled client's string table is packed in a way that
 * makes extracting the vocabulary unreliable. Rather than depend on exact
 * names, dispatch is by *shape*: an event carrying a string `delta` and a
 * text-ish name is a text delta, one whose name mentions `reasoning` is a
 * reasoning delta, and so on. An unknown name still falls through harmlessly.
 * This is strictly more robust than an exact-match table and costs nothing when
 * the names are the ones expected.
 *
 * @module dsh-codex-provider/stream
 */
import { LlmError } from './llm-error.js'
import { toFinishReason, toTokenUsage } from './convert.js'

/**
 * Incrementally convert Responses events into harness chunks.
 *
 * Usage note: feed events with {@link push}, then call {@link end} to obtain the
 * terminal chunk. Every method returns the chunks produced by that input.
 */
export class StreamTranslator {
  #blocks = new Map()
  #nextIndex = 0
  #usage
  #response
  #failure
  #sawToolCall = false
  #sawContent = false
  /** Accumulated text per block, so a block can be closed even without a `done` event. */
  #acc = new Map()

  /**
   * Allocate a harness block index for one Responses output item.
   * @param key - stable key identifying the block within the response.
   * @param kind - the harness block type to open.
   * @returns the assigned index and the `block-start` chunk.
   */
  #open(key, kind) {
    const existing = this.#blocks.get(key)
    if (existing !== undefined) return { index: existing, start: undefined }
    const index = this.#nextIndex++
    this.#blocks.set(key, index)
    this.#acc.set(index, { key, kind, text: '', callId: '', name: '', args: '', closed: false })
    return { index, start: { type: 'block-start', index, blockType: kind } }
  }

  /**
   * Accumulate a delta against its block so a dangling block can still be
   * closed with the right assembled content.
   * @param index - the block index.
   * @param field - which accumulator to extend.
   * @param value - the delta text.
   */
  #accumulate(index, field, value) {
    const state = this.#acc.get(index)
    if (state !== undefined) state[field] += value
  }

  /**
   * Mark a block closed so {@link end} does not close it a second time.
   * @param index - the block index.
   */
  #markClosed(index) {
    const state = this.#acc.get(index)
    if (state !== undefined) state.closed = true
  }

  /**
   * Feed one parsed Responses event.
   * @param event - a parsed SSE payload.
   * @returns the harness chunks this event produced.
   */
  push(event) {
    const chunks = []
    if (event === null || typeof event !== 'object') return chunks

    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
        if (event.response !== undefined) this.#response = event.response
        break

      case 'response.output_item.added': {
        const item = event.item
        if (item?.type === 'function_call') {
          this.#sawToolCall = true
          const { index, start } = this.#open(`call:${item.id ?? event.output_index}`, 'tool-call')
          if (start !== undefined) chunks.push(start)
        } else if (item?.type === 'reasoning') {
          // Announced but potentially silent; the first delta opens the block so
          // an empty reasoning item produces no spurious block.
        }
        break
      }

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const text = typeof event.delta === 'string' ? event.delta : ''
        if (text.length === 0) break
        const key = `reasoning:${event.item_id ?? event.output_index}`
        const { index, start } = this.#open(key, 'reasoning')
        if (start !== undefined) chunks.push(start)
        this.#sawContent = true
        this.#accumulate(index, 'text', text)
        chunks.push({ type: 'reasoning-delta', index, text })
        break
      }

      case 'response.output_text.delta': {
        const text = typeof event.delta === 'string' ? event.delta : ''
        if (text.length === 0) break
        const key = `text:${event.item_id ?? event.output_index}:${event.content_index ?? 0}`
        const { index, start } = this.#open(key, 'text')
        if (start !== undefined) chunks.push(start)
        this.#sawContent = true
        this.#accumulate(index, 'text', text)
        chunks.push({ type: 'text-delta', index, text })
        break
      }

      case 'response.function_call_arguments.delta': {
        const delta = typeof event.delta === 'string' ? event.delta : ''
        const key = `call:${event.item_id ?? event.output_index}`
        const { index, start } = this.#open(key, 'tool-call')
        if (start !== undefined) chunks.push(start)
        const callId = String(event.item_id ?? event.call_id ?? event.output_index ?? '')
        this.#accumulate(index, 'args', delta)
        const state = this.#acc.get(index)
        if (state !== undefined && state.callId.length === 0) state.callId = callId
        chunks.push({
          type: 'tool-call-delta',
          index,
          id: callId,
          argumentsDelta: delta,
        })
        break
      }

      case 'response.output_item.done': {
        const item = event.item
        if (item?.type === 'function_call') {
          // A stream may deliver only `done` for a call (no `added`), and a call
          // is content: record it before opening the block so the turn is not
          // mistaken for an empty response.
          this.#sawToolCall = true
          const key = `call:${item.id ?? item.call_id ?? event.output_index}`
          const { index, start } = this.#open(key, 'tool-call')
          if (start !== undefined) chunks.push(start)
          this.#markClosed(index)
          chunks.push({
            type: 'block-end',
            index,
            block: {
              type: 'tool-call',
              id: String(item.call_id ?? item.id ?? ''),
              name: String(item.name ?? ''),
              arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
            },
          })
        } else if (item?.type === 'message') {
          // Close each text part with its assembled content.
          const parts = Array.isArray(item.content) ? item.content : []
          parts.forEach((part, partIndex) => {
            if (part?.type !== 'output_text') return
            const key = `text:${item.id ?? event.output_index}:${partIndex}`
            const { index, start } = this.#open(key, 'text')
            if (start !== undefined) chunks.push(start)
            this.#sawContent = true
            this.#markClosed(index)
            chunks.push({ type: 'block-end', index, block: { type: 'text', text: String(part.text ?? '') } })
          })
        } else if (item?.type === 'reasoning') {
          const summary = Array.isArray(item.summary)
            ? item.summary.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
            : typeof item.summary === 'string' ? item.summary : ''
          if (summary.length > 0) {
            const key = `reasoning:${item.id ?? event.output_index}`
            const { index, start } = this.#open(key, 'reasoning')
            if (start !== undefined) chunks.push(start)
            this.#sawContent = true
            this.#markClosed(index)
            chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text: summary } })
          }
        }
        break
      }

      case 'response.completed':
      case 'response.incomplete':
      case 'response.failed': {
        if (event.response !== undefined) this.#response = event.response
        break
      }

      case 'response.error':
      case 'error': {
        const detail = event.error ?? event
        this.#failure = new LlmError(
          `dsh-codex-provider: the backend reported an error mid-stream (${detail?.message ?? 'no detail'})`,
          'PROVIDER_ERROR',
          { status: typeof detail?.status === 'number' ? detail.status : undefined },
        )
        break
      }

      default:
        // Shape-based fallback. Exact names are handled above; this catches a
        // renamed or newly-introduced variant by what the event *carries*
        // rather than what it is called, so a protocol revision degrades into
        // slightly-worse attribution instead of a silently empty turn.
        for (const chunk of this.#byShape(event)) chunks.push(chunk)
        break
    }
    return chunks
  }

  /**
   * Interpret an event whose exact name is not recognized, using its payload
   * shape and a coarse name classification.
   * @param event - the unrecognized event.
   * @returns any chunks it produced.
   */
  #byShape(event) {
    const chunks = []
    const type = typeof event.type === 'string' ? event.type : ''

    // A terminal response object, whatever the event was called.
    if (event.response !== undefined && typeof event.response === 'object') {
      const status = event.response.status
      if (status === 'completed' || status === 'incomplete' || status === 'failed' || status === 'cancelled') {
        if (this.#response === undefined) this.#response = event.response
      }
    }

    // An error carried in-band.
    if (this.#failure === undefined && event.error !== undefined && typeof event.error === 'object') {
      this.#failure = new LlmError(
        `dsh-codex-provider: the backend reported an error mid-stream (${event.error.message ?? 'no detail'})`,
        'PROVIDER_ERROR',
        { status: typeof event.error.status === 'number' ? event.error.status : undefined },
      )
    }

    // Cumulative text carried by an item rather than streamed as deltas.
    if (event.item?.type === 'message') {
      const parts = Array.isArray(event.item.content) ? event.item.content : []
      parts.forEach((part, partIndex) => {
        if (part?.type !== 'output_text' || typeof part.text !== 'string') return
        const key = `text:${event.item.id ?? event.output_index}:${partIndex}`
        const { index, start } = this.#open(key, 'text')
        if (start !== undefined) chunks.push(start)
        this.#sawContent = true
        this.#markClosed(index)
        chunks.push({ type: 'block-end', index, block: { type: 'text', text: part.text } })
      })
    }

    // A delta, classified by name.
    const delta = typeof event.delta === 'string' ? event.delta : undefined
    if (delta !== undefined && delta.length > 0) {
      const isReasoning = /reasoning|thinking|summary/i.test(type)
      const isArguments = /arguments|tool_call|function_call/i.test(type)
      if (isArguments) {
        // A call assembled purely from deltas is still a tool call; not
        // recording it here would let the turn be misreported as empty.
        this.#sawToolCall = true
        const key = `call:${event.item_id ?? event.call_id ?? event.output_index}`
        const { index, start } = this.#open(key, 'tool-call')
        if (start !== undefined) chunks.push(start)
        this.#accumulate(index, 'args', delta)
        const callId = String(event.item_id ?? event.call_id ?? event.output_index ?? '')
        const state = this.#acc.get(index)
        if (state !== undefined && state.callId.length === 0) state.callId = callId
        chunks.push({ type: 'tool-call-delta', index, id: callId, argumentsDelta: delta })
      } else if (/output_text|text/i.test(type)) {
        const key = `text:${event.item_id ?? event.output_index}:${event.content_index ?? 0}`
        const { index, start } = this.#open(key, 'text')
        if (start !== undefined) chunks.push(start)
        this.#sawContent = true
        this.#accumulate(index, 'text', delta)
        chunks.push({ type: 'text-delta', index, text: delta })
      } else if (isReasoning) {
        const key = `reasoning:${event.item_id ?? event.output_index}`
        const { index, start } = this.#open(key, 'reasoning')
        if (start !== undefined) chunks.push(start)
        this.#sawContent = true
        this.#accumulate(index, 'text', delta)
        chunks.push({ type: 'reasoning-delta', index, text: delta })
      }
    }
    return chunks
  }

  /**
   * Close the stream and produce the terminal chunks.
   *
   * Emits `block-end` for any block that never received one (the backend can
   * end a stream without an `output_item.done` for every item), then usage and
   * exactly one finish chunk.
   *
   * @returns the closing chunks.
   */
  end() {
    const chunks = []
    if (this.#failure !== undefined) {
      chunks.push({ type: 'finish', reason: { kind: 'error', failure: this.#failure.failure } })
      return chunks
    }

    // Close every block the backend opened but never closed. A stream can end
    // without an `output_item.done` for each item, and the harness assembles a
    // message from `block-end` — leaving one open would silently drop content.
    for (const [index, state] of this.#acc) {
      if (state.closed) continue
      state.closed = true
      if (state.kind === 'text') {
        chunks.push({ type: 'block-end', index, block: { type: 'text', text: state.text } })
      } else if (state.kind === 'reasoning') {
        chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text: state.text } })
      } else if (state.kind === 'tool-call') {
        chunks.push({
          type: 'block-end',
          index,
          block: { type: 'tool-call', id: state.callId, name: state.name, arguments: state.args.length > 0 ? state.args : '{}' },
        })
      }
    }

    const usage = toTokenUsage(this.#response?.usage)
    if (usage !== undefined) chunks.push({ type: 'usage', usage })

    if (this.#response === undefined) {
      chunks.push({
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: 'dsh-codex-provider: the response stream ended without a terminal event', code: 'TRANSPORT' },
        },
      })
      return chunks
    }

    const reason = toFinishReason(this.#response)
    // A response that produced no blocks at all is a degenerate completion; the
    // harness treats it as a retryable failure rather than an empty turn.
    if (reason.kind === 'stop' && !this.#sawContent && !this.#sawToolCall) {
      chunks.push({
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'dsh-codex-provider: the model returned an empty response', code: 'EMPTY_RESPONSE' } },
      })
      return chunks
    }
    // A tool-call turn must not claim a plain stop; the loop routes on this.
    if (reason.kind === 'stop' && this.#sawToolCall) {
      chunks.push({ type: 'finish', reason: { kind: 'tool-calls' } })
      return chunks
    }
    chunks.push({ type: 'finish', reason })
    return chunks
  }

  /** Whether the response produced any tool call. */
  get sawToolCall() {
    return this.#sawToolCall
  }
}
