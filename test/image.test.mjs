// Image-input end-to-end: the adapter must resolve a durable attachment
// through the attachment service and put the bytes on the wire as an
// `input_image` data URL.
//
// The conversion helpers are covered in convert.test.mjs, but the seam between
// the adapter and the attachment service was not: that is the code that decides
// which image bytes a provider actually receives, and getting it wrong means
// silently sending a text placeholder instead of the image.
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { CodexAdapter, PROVIDER_ID } from '../lib/adapter.js'
import { Config } from '../lib/config.js'

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed++
    console.log(`FAIL  ${name}\n      ${error.message}`)
  }
}

const CATALOG = JSON.stringify({
  models: [
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      context_window: 272000,
      input_modalities: ['text', 'image'],
      supported_reasoning_levels: [{ effort: 'low' }],
    },
    {
      slug: 'text-only-model',
      display_name: 'Text Only',
      context_window: 272000,
      input_modalities: ['text'],
    },
  ],
})

const TEXT_TURN = [
  { type: 'response.created', response: { id: 'r', status: 'in_progress' } },
  { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: 'seen' },
  { type: 'response.completed', response: { id: 'r', status: 'completed', usage: { input_tokens: 5, output_tokens: 1 } } },
]

/** Capture the request body the adapter sends. */
async function stub() {
  let captured
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.url.startsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(CATALOG)
        return
      }
      captured = { url: req.url, body }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const e of TEXT_TURN) res.write(`data: ${JSON.stringify(e)}\n\n`)
      res.end()
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return {
    baseURL: `http://127.0.0.1:${server.address().port}`,
    request: () => captured,
    stop: () => new Promise((r) => server.close(r)),
  }
}

const imageMessage = (attachment) => ({
  id: 'm1',
  role: 'user',
  content: [{ type: 'text', text: 'what is this' }, { type: 'image', attachment }],
  source: { kind: 'user' },
})

function adapterFor(baseURL, imageAccess) {
  return new CodexAdapter({
    config: () => ({ ...Config({}), baseURL, refreshMinutes: 60 }),
    resolveCredential: async () => ({ accessToken: 't', accountId: 'a' }),
    imageAccess,
  })
}

async function drain(iterable) {
  const out = []
  for await (const c of iterable) out.push(c)
  return out
}

console.log('image input through the adapter')

await test('resolved image bytes become an input_image data URL', async () => {
  const s = await stub()
  // The attachment service hands back a provider-ready encoded variant.
  const seenTargets = []
  const adapter = adapterFor(s.baseURL, {
    resolveInline: async (ref) => {
      seenTargets.push(ref.attachmentId)
      return { mediaType: 'image/png', base64: 'aGVsbG8=' }
    },
  })
  await drain(adapter.stream({ provider: PROVIDER_ID, model: 'gpt-6-astra', messages: [imageMessage({ attachmentId: 'att-1', mediaType: 'image/png', bytes: 5 })] }))
  const body = JSON.parse(s.request().body)
  await s.stop()

  const parts = body.input[0].content
  assert.equal(parts[0].type, 'input_text')
  assert.equal(parts[1].type, 'input_image')
  assert.equal(parts[1].image_url, 'data:image/png;base64,aGVsbG8=')
  assert.deepEqual(seenTargets, ['att-1'])
})

await test('an unresolvable image degrades to a visible placeholder, not a drop', async () => {
  const s = await stub()
  const adapter = adapterFor(s.baseURL, { resolveInline: async () => undefined })
  await drain(adapter.stream({ provider: PROVIDER_ID, model: 'gpt-6-astra', messages: [imageMessage({ attachmentId: 'att-1', mediaType: 'image/png', bytes: 5 })] }))
  const body = JSON.parse(s.request().body)
  await s.stop()

  const parts = body.input[0].content
  assert.equal(parts[1].type, 'input_text')
  assert.match(parts[1].text, /omitted|could not be read/i)
  // The model must still learn that an image was present.
  assert.equal(parts.length, 2)
})

await test('a throwing attachment service does not fail the turn', async () => {
  const s = await stub()
  const adapter = adapterFor(s.baseURL, {
    resolveInline: async () => { throw new Error('attachment store offline') },
  })
  const chunks = await drain(adapter.stream({ provider: PROVIDER_ID, model: 'gpt-6-astra', messages: [imageMessage({ attachmentId: 'a', mediaType: 'image/png', bytes: 1 })] }))
  const body = JSON.parse(s.request().body)
  await s.stop()

  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
  assert.equal(body.input[0].content[1].type, 'input_text')
})

await test('an offloaded image is not re-resolved', async () => {
  const s = await stub()
  let calls = 0
  const adapter = adapterFor(s.baseURL, {
    resolveInline: async () => { calls++; return { mediaType: 'image/png', base64: 'AA==' } },
  })
  await drain(adapter.stream({
    provider: PROVIDER_ID,
    model: 'gpt-6-astra',
    messages: [{
      id: 'm1',
      role: 'user',
      // An offloaded occurrence is deliberately sent as placeholder text.
      content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1 }, offloaded: true }],
      source: { kind: 'user' },
    }],
  }))
  await s.stop()
  assert.equal(calls, 0)
})

await test('image input on a text-only model is refused before any request', async () => {
  const s = await stub()
  const adapter = adapterFor(s.baseURL, { resolveInline: async () => ({ mediaType: 'image/png', base64: 'AA==' }) })
  await assert.rejects(
    () => drain(adapter.stream({ provider: PROVIDER_ID, model: 'text-only-model', messages: [imageMessage({ attachmentId: 'a', mediaType: 'image/png', bytes: 1 })] })),
    (e) => e.code === 'UNSUPPORTED_CONTENT' && /does not accept image/i.test(e.message),
  )
  // Refused before dispatch: no /responses request should have been made.
  assert.equal(s.request(), undefined)
  await s.stop()
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
