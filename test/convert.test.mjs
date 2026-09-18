// Protocol conversion tests: harness messages <-> Responses API, and the
// SSE -> StreamChunk translation.
import { strict as assert } from 'node:assert'
import {
  flattenText,
  parseEvents,
  toFinishReason,
  toRequestError,
  toResponsesInput,
  toResponsesInputWithImages,
  toResponsesTools,
  toTokenUsage,
} from '../lib/convert.js'
import { StreamTranslator } from '../lib/stream.js'

let passed = 0
let failed = 0
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}

const msg = (role, content, source) => ({ id: `m-${Math.random()}`, role, content, source: source ?? { kind: 'user' } })

console.log('convert.js')

test('flattenText joins text blocks and ignores others', () => {
  assert.equal(flattenText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }]), 'ab')
})

test('a leading system message becomes instructions', () => {
  const out = toResponsesInput({
    messages: [msg('system', [{ type: 'text', text: 'be terse' }], { kind: 'plugin', plugin: 'p' }), msg('user', [{ type: 'text', text: 'hi' }])],
  })
  assert.equal(out.instructions, 'be terse')
  assert.equal(out.input.length, 1)
  assert.deepEqual(out.input[0].content, [{ type: 'input_text', text: 'hi' }])
})

test('options.system and a system message both fold into instructions', () => {
  const out = toResponsesInput({
    system: 'outer',
    messages: [msg('system', [{ type: 'text', text: 'inner' }], { kind: 'plugin', plugin: 'p' })],
  })
  assert.equal(out.instructions, 'outer\n\ninner')
  assert.equal(out.input.length, 0)
})

test('assistant text becomes output_text', () => {
  const out = toResponsesInput({ messages: [msg('assistant', [{ type: 'text', text: 'hello' }], { kind: 'model', provider: 'codex', model: 'x' })] })
  assert.deepEqual(out.input[0], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hello' }] })
})

test('assistant tool calls become function_call items with string arguments', () => {
  const out = toResponsesInput({
    messages: [msg('assistant', [
      { type: 'text', text: 'calling' },
      { type: 'tool-call', id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' },
    ], { kind: 'model', provider: 'codex', model: 'x' })],
  })
  assert.equal(out.input.length, 2)
  assert.deepEqual(out.input[1], { type: 'function_call', call_id: 'call_1', name: 'read', arguments: '{"path":"a.txt"}' })
})

test('an empty tool-call argument string becomes {}', () => {
  const out = toResponsesInput({
    messages: [msg('assistant', [{ type: 'tool-call', id: 'c', name: 'f', arguments: '' }], { kind: 'model', provider: 'codex', model: 'x' })],
  })
  assert.equal(out.input[0].arguments, '{}')
})

test('reasoning blocks are not replayed', () => {
  const out = toResponsesInput({
    messages: [msg('assistant', [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'answer' }], { kind: 'model', provider: 'codex', model: 'x' })],
  })
  assert.equal(out.input.length, 1)
  assert.equal(out.input[0].content[0].text, 'answer')
})

test('tool results become function_call_output correlated by call id', () => {
  const out = toResponsesInput({
    messages: [msg('user', [{ type: 'tool-result', toolCallId: 'call_1', content: [{ type: 'text', text: 'file body' }] }], { kind: 'tool', callId: 'call_1' })],
  })
  assert.deepEqual(out.input[0], { type: 'function_call_output', call_id: 'call_1', output: 'file body' })
})

test('a tool result and user text in one message split into two items', () => {
  const out = toResponsesInput({
    messages: [msg('user', [
      { type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'r' }] },
      { type: 'text', text: 'and also' },
    ], { kind: 'tool', callId: 'c1' })],
  })
  assert.equal(out.input.length, 2)
  assert.equal(out.input[0].type, 'function_call_output')
  assert.equal(out.input[1].type, 'message')
})

test('unresolvable images degrade to a visible placeholder', () => {
  const out = toResponsesInput({
    messages: [msg('user', [{ type: 'text', text: 'see' }, { type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 3 } }])],
  })
  const content = out.input[0].content
  assert.equal(content[1].type, 'input_text')
  assert.match(content[1].text, /image omitted/)
})

test('documents are named, not inlined', () => {
  const out = toResponsesInput({
    messages: [msg('user', [{ type: 'file', attachment: { attachmentId: 'f', mediaType: 'text/plain', bytes: 1, name: 'notes.txt' } }])],
  })
  assert.match(out.input[0].content[0].text, /notes\.txt/)
})

test('tools map to the Responses tool shape', () => {
  const tools = toResponsesTools([{ name: 'read', description: 'reads', parameters: { type: 'object' } }])
  assert.deepEqual(tools[0], { type: 'function', name: 'read', description: 'reads', parameters: { type: 'object' }, strict: false })
})

test('no tools yields undefined rather than an empty array', () => {
  assert.equal(toResponsesTools([]), undefined)
  assert.equal(toResponsesTools(undefined), undefined)
})

test('resolved images become input_image data URLs', () => {
  const out = toResponsesInputWithImages({
    messages: [msg('user', [
      { type: 'text', text: 'see' },
      { type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 3 }, resolved: { mediaType: 'image/png', base64: 'AAA=' } },
    ])],
  })
  const content = out.input[0].content
  assert.equal(content[1].type, 'input_image')
  assert.equal(content[1].image_url, 'data:image/png;base64,AAA=')
})

test('with-images keeps item ordering for mixed history', () => {
  const out = toResponsesInputWithImages({
    messages: [
      msg('user', [{ type: 'text', text: 'plain' }]),
      msg('assistant', [{ type: 'tool-call', id: 'c1', name: 'f', arguments: '{}' }], { kind: 'model', provider: 'codex', model: 'x' }),
      msg('user', [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'r' }] }], { kind: 'tool', callId: 'c1' }),
      msg('user', [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1 }, resolved: { mediaType: 'image/png', base64: 'AA==' } }]),
    ],
  })
  assert.deepEqual(out.input.map((i) => i.type), ['message', 'function_call', 'function_call_output', 'message'])
  assert.equal(out.input[3].content[0].type, 'input_image')
})

console.log('\nusage mapping')

test('cached input is subtracted so counts stay disjoint', () => {
  const usage = toTokenUsage({ input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 800 } })
  assert.equal(usage.inputTokens, 200)
  assert.equal(usage.cacheReadTokens, 800)
  assert.equal(usage.outputTokens, 50)
  assert.equal(usage.totalTokens, 1050)
})

test('reasoning tokens are surfaced separately', () => {
  const usage = toTokenUsage({ input_tokens: 10, output_tokens: 20, output_tokens_details: { reasoning_tokens: 7 } })
  assert.equal(usage.reasoningTokens, 7)
})

test('an empty usage object yields undefined', () => {
  assert.equal(toTokenUsage({}), undefined)
  assert.equal(toTokenUsage(null), undefined)
})

console.log('\nfinish reasons')

test('incomplete for max tokens maps to max-tokens', () => {
  assert.deepEqual(toFinishReason({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), { kind: 'max-tokens' })
})

test('a failed response maps to an error finish', () => {
  const reason = toFinishReason({ status: 'failed', error: { message: 'boom' } })
  assert.equal(reason.kind, 'error')
  assert.equal(reason.failure.message, 'boom')
})

test('a completed response maps to stop', () => {
  assert.deepEqual(toFinishReason({ status: 'completed' }), { kind: 'stop' })
})

console.log('\nerror mapping')

const quota = (d) => /usage_limit_reached|quota/i.test(d)
const ctxOver = (d) => /context/i.test(d)

test('401 maps to AUTH', () => {
  const err = toRequestError(401, '{"error":{"message":"bad token"}}', quota, ctxOver)
  assert.equal(err.code, 'AUTH')
})

test('429 with usage_limit_reached maps to QUOTA with a reset hint', () => {
  const err = toRequestError(429, '{"error":{"type":"usage_limit_reached","resets_in_seconds":3600}}', quota, ctxOver)
  assert.equal(err.code, 'QUOTA')
  assert.equal(err.failure.providerRetryAfterMs, 3_600_000)
})

test('429 without quota wording maps to RATE_LIMIT', () => {
  const err = toRequestError(429, '{"error":{"type":"rate_limit"}}', quota, ctxOver)
  assert.equal(err.code, 'RATE_LIMIT')
})

test('context overflow wording maps to CONTEXT_WINDOW_EXCEEDED', () => {
  const err = toRequestError(400, '{"error":{"message":"context window exceeded"}}', quota, ctxOver)
  assert.equal(err.code, 'CONTEXT_WINDOW_EXCEEDED')
})

test('404 maps to UNKNOWN_MODEL', () => {
  const err = toRequestError(404, 'nope', quota, ctxOver)
  assert.equal(err.code, 'UNKNOWN_MODEL')
})

test('an HTML error body does not crash the mapper', () => {
  const err = toRequestError(500, '<html>oops</html>', quota, ctxOver)
  assert.equal(err.code, 'PROVIDER_ERROR')
  assert.match(err.message, /HTTP 500/)
})

console.log('\nSSE parsing')

test('parseEvents reads data lines and skips [DONE]', () => {
  const events = parseEvents('data: {"type":"a"}\n\ndata: [DONE]\n\ndata: {"type":"b"}\n')
  assert.deepEqual(events.map((e) => e.type), ['a', 'b'])
})

test('a malformed frame is skipped, not fatal', () => {
  const events = parseEvents('data: {oops\n\ndata: {"type":"ok"}\n')
  assert.deepEqual(events.map((e) => e.type), ['ok'])
})

console.log('\nstream translation')

function run(events) {
  const t = new StreamTranslator()
  const chunks = []
  for (const e of events) chunks.push(...t.push(e))
  chunks.push(...t.end())
  return chunks
}

test('a text turn produces start, delta, end, usage, finish', () => {
  const chunks = run([
    { type: 'response.created', response: { id: 'r1', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'Hel' },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'lo' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Hello' }] } },
    { type: 'response.completed', response: { id: 'r1', status: 'completed', usage: { input_tokens: 5, output_tokens: 2 } } },
  ])
  const kinds = chunks.map((c) => c.type)
  assert.deepEqual(kinds, ['block-start', 'text-delta', 'text-delta', 'block-end', 'usage', 'finish'])
  assert.equal(chunks[1].text, 'Hel')
  assert.equal(chunks[3].block.text, 'Hello')
  assert.deepEqual(chunks[5].reason, { kind: 'stop' })
})

test('interleaved text and tool call get distinct block indexes', () => {
  const chunks = run([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } },
    { type: 'response.output_text.delta', item_id: 'm1', content_index: 0, delta: 'I will read' },
    { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'read' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"pa' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: 'th":"a"}' },
    { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc1', call_id: 'call_1', name: 'read', arguments: '{"path":"a"}' } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const textStart = chunks.find((c) => c.type === 'block-start' && c.blockType === 'text')
  const callStart = chunks.find((c) => c.type === 'block-start' && c.blockType === 'tool-call')
  assert.notEqual(textStart.index, callStart.index)
  const end = chunks.find((c) => c.type === 'block-end' && c.block.type === 'tool-call')
  assert.equal(end.block.id, 'call_1')
  assert.equal(end.block.name, 'read')
  assert.equal(end.block.arguments, '{"path":"a"}')
})

test('a tool-call turn finishes with tool-calls even if status is completed', () => {
  const chunks = run([
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc', call_id: 'c', name: 'f', arguments: '{}' } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const finish = chunks.at(-1)
  assert.deepEqual(finish.reason, { kind: 'tool-calls' })
})

test('reasoning summaries become a reasoning block', () => {
  const chunks = run([
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs1' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'rs1', output_index: 0, delta: 'weighing options' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'rs1', summary: [{ text: 'weighing options' }] } },
    { type: 'response.output_text.delta', item_id: 'm1', output_index: 1, content_index: 0, delta: 'done' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const reasoning = chunks.find((c) => c.type === 'block-end' && c.block.type === 'reasoning')
  const text = chunks.find((c) => c.type === 'block-end' && c.block.type === 'text')
  assert.equal(reasoning.block.text, 'weighing options')
  assert.notEqual(reasoning.index, text.index)
  assert.equal(text.block.text, 'done')
})

test('a stream without a terminal event finishes as a transport error', () => {
  const chunks = run([{ type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'partial' }])
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'TRANSPORT')
})

test('an empty completion is reported as EMPTY_RESPONSE', () => {
  const chunks = run([{ type: 'response.completed', response: { id: 'r', status: 'completed' } }])
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
})

test('an in-band error event ends the stream as an error', () => {
  const chunks = run([
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'x' },
    { type: 'error', error: { message: 'backend exploded', status: 500 } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const finish = chunks.at(-1)
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /backend exploded/)
})

test('unknown event types are ignored without breaking the turn', () => {
  const chunks = run([
    { type: 'response.some_future_event', payload: {} },
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'ok' },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})

test('multi-part text content indexes separately', () => {
  const chunks = run([
    { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: 'first' },
    { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 1, delta: 'second' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'first' }, { type: 'output_text', text: 'second' }] } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const starts = chunks.filter((c) => c.type === 'block-start')
  assert.equal(starts.length, 2)
  assert.notEqual(starts[0].index, starts[1].index)
  const ends = chunks.filter((c) => c.type === 'block-end')
  assert.equal(ends.length, 2)
})

test('block indexes are allocated densely from zero', () => {
  const chunks = run([
    { type: 'response.output_text.delta', item_id: 'a', content_index: 0, delta: 'x' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'b', delta: 'y' },
    { type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', id: 'c', name: 'f' } },
    { type: 'response.completed', response: { id: 'r', status: 'completed' } },
  ])
  const indexes = chunks.filter((c) => c.type === 'block-start').map((c) => c.index)
  assert.deepEqual(indexes, [0, 1, 2])
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
