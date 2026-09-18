// Catalog and adapter tests. The transport is stubbed by pointing the plugin at
// a local base URL, so these run offline and deterministically.
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { CodexCatalog, normalizeCatalog, normalizeModel, prettifyModelName, reasoningInfo } from '../lib/catalog.js'
import { DEFAULT_CLIENT_VERSION } from '../lib/transport.js'
import { CodexAdapter, DISPLAY_NAME, PROVIDER_ID, FALLBACK_PROVIDER_ID } from '../lib/adapter.js'
import { assertBaseURL, Config } from '../lib/config.js'
import { normalizeUsage, normalizeWindow } from '../lib/usage.js'
import { parseProxy, proxyFor } from '../lib/transport.js'
import { isContextWindowExceeded, isQuotaExceeded } from '../lib/llm-error.js'

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

console.log('catalog.js')

await test('normalizeModel reads the real backend shape', () => {
  const model = normalizeModel({
    slug: 'gpt-6-astra',
    display_name: 'GPT-6-Astra',
    context_window: 272000,
    max_context_window: 872000,
    input_modalities: ['text', 'image'],
    supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
    default_reasoning_level: 'low',
    description: 'capable',
  })
  assert.equal(model.id, 'gpt-6-astra')
  assert.equal(model.name, 'GPT-6-Astra')
  assert.equal(model.contextWindow, 272000)
  assert.deepEqual(model.efforts, ['low', 'high'])
  assert.deepEqual(model.input, ['text', 'image'])
  assert.equal(model.defaultEffort, 'low')
})

await test('normalizeModel tolerates a minimal entry', () => {
  const model = normalizeModel({ id: 'x-1' })
  assert.equal(model.id, 'x-1')
  assert.equal(model.reasoning, false)
  assert.deepEqual(model.input, ['text'])
  assert.ok(model.contextWindow > 0)
})

await test('normalizeModel drops an entry with no id', () => {
  assert.equal(normalizeModel({ name: 'nameless' }), undefined)
})

await test('normalizeCatalog accepts both models and data keys', () => {
  assert.equal(normalizeCatalog({ models: [{ slug: 'a' }] }).length, 1)
  assert.equal(normalizeCatalog({ data: [{ id: 'b' }] }).length, 1)
  assert.equal(normalizeCatalog({}).length, 0)
})

await test('prettifyModelName title-cases but keeps versions', () => {
  assert.equal(prettifyModelName('gpt-5.6-luna'), 'GPT-5.6-Luna')
  assert.equal(prettifyModelName('codex-auto-review'), 'Codex-Auto-Review')
})

await test('reasoningInfo is undefined for a non-reasoning model', () => {
  assert.equal(reasoningInfo({ reasoning: false }), undefined)
  assert.equal(reasoningInfo({ reasoning: true, efforts: [] }), undefined)
})

await test('reasoningInfo names known efforts and keeps the default', () => {
  const info = reasoningInfo({ reasoning: true, efforts: ['low', 'xhigh'], defaultEffort: 'xhigh' })
  assert.deepEqual(info.efforts, [{ id: 'low', name: 'Low' }, { id: 'xhigh', name: 'Extra High' }])
  assert.equal(info.defaultEffort, 'xhigh')
})

await test('reasoningInfo drops a default the model does not offer', () => {
  const info = reasoningInfo({ reasoning: true, efforts: ['low'], defaultEffort: 'ultra' })
  assert.equal(info.defaultEffort, undefined)
})

console.log('\nconfig.js')

await test('assertBaseURL accepts https and strips trailing slashes', () => {
  assert.equal(assertBaseURL('https://chatgpt.com/backend-api/codex/'), 'https://chatgpt.com/backend-api/codex')
})

await test('assertBaseURL rejects a relative value', () => {
  assert.throws(() => assertBaseURL('not-a-url'), /absolute URL/)
})

await test('assertBaseURL rejects a non-http scheme', () => {
  assert.throws(() => assertBaseURL('ftp://x/y'), /http or https/)
})

await test('Config supplies working defaults', () => {
  const config = Config({})
  assert.equal(config.enabled, true)
  assert.match(config.baseURL, /chatgpt\.com/)
  assert.equal(config.refreshMinutes, 5)
  assert.ok(config.streamIdleTimeoutMs > 0)
  assert.ok(Array.isArray(config.catalogAdditions))
})

console.log('\ntransport proxy parsing')

await test('parseProxy reads a url', () => {
  assert.deepEqual(parseProxy('http://127.0.0.1:7897'), { host: '127.0.0.1', port: 7897 })
})

await test('parseProxy reads a bare host:port', () => {
  assert.deepEqual(parseProxy('127.0.0.1:8080'), { host: '127.0.0.1', port: 8080 })
})

await test('parseProxy returns undefined for empty input', () => {
  assert.equal(parseProxy(''), undefined)
  assert.equal(parseProxy(undefined), undefined)
})

await test('parseProxy carries credentials', () => {
  const proxy = parseProxy('http://user:pass@127.0.0.1:3128')
  assert.equal(proxy.auth, 'user:pass')
})

await test('proxyFor prefers HTTPS_PROXY', () => {
  assert.equal(proxyFor({ HTTPS_PROXY: 'http://a:1' }, 'chatgpt.com').port, 1)
})

await test('proxyFor honours NO_PROXY', () => {
  assert.equal(proxyFor({ HTTPS_PROXY: 'http://a:1', NO_PROXY: 'chatgpt.com' }, 'chatgpt.com'), undefined)
  assert.equal(proxyFor({ HTTPS_PROXY: 'http://a:1', NO_PROXY: '*' }, 'chatgpt.com'), undefined)
})

await test('proxyFor falls back to ALL_PROXY', () => {
  assert.equal(proxyFor({ ALL_PROXY: 'http://b:2' }, 'chatgpt.com').port, 2)
})

console.log('\nusage normalization')

await test('normalizeWindow reads percent and reset', () => {
  const w = normalizeWindow({ used_percent: 42, resets_at: '2026-09-19T10:00:00Z', window_minutes: 300 })
  assert.equal(w.usedPercent, 42)
  assert.equal(w.windowMinutes, 300)
})

await test('normalizeWindow rejects an unusable object', () => {
  assert.equal(normalizeWindow({}), undefined)
  assert.equal(normalizeWindow(null), undefined)
  assert.equal(normalizeWindow('x'), undefined)
})

await test('normalizeUsage reads known window names', () => {
  const usage = normalizeUsage({ primary: { used_percent: 10 }, secondary: { used_percent: 20 }, plan_type: 'plus' })
  assert.equal(usage.windows.primary.usedPercent, 10)
  assert.equal(usage.windows.secondary.usedPercent, 20)
  assert.equal(usage.planType, 'plus')
})

await test('normalizeUsage falls back to a rate_limits map', () => {
  const usage = normalizeUsage({ rate_limits: { rolling: { used_percent: 5 } } })
  assert.equal(usage.windows.rolling.usedPercent, 5)
})

await test('normalizeUsage returns undefined when nothing is window-shaped', () => {
  assert.equal(normalizeUsage({ unrelated: true }), undefined)
  assert.equal(normalizeUsage(null), undefined)
})

console.log('\nerror classifiers')

await test('quota classifier matches the backend wording', () => {
  assert.equal(isQuotaExceeded('usage_limit_reached'), true)
  assert.equal(isQuotaExceeded('rate_limit_exceeded'), false)
})

await test('context classifier matches overflow wording', () => {
  assert.equal(isContextWindowExceeded('context_length_exceeded'), true)
  assert.equal(isContextWindowExceeded('bad request'), false)
})

console.log('\ncatalog resolution against a stub backend')

/** Start a stub backend and return its base URL plus a stop function. */
async function stub(handler) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => handler(req, res, body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { baseURL: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => server.close(r)) }
}

/**
 * Build a catalog pointed at a stub backend.
 * @param baseURL - stub origin.
 * @param options - optional version overrides.
 * @returns a catalog whose fetches hit the stub.
 */
function catalogAgainst(baseURL, options = {}) {
  return new CodexCatalog({
    baseURL,
    resolveCredential: async () => ({ accessToken: 't', accountId: 'a' }),
    clientVersion: options.clientVersion,
    discoverVersion: options.discoverVersion,
  })
}

const catalogBody = JSON.stringify({
  models: [
    { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', context_window: 272000, input_modalities: ['text', 'image'], supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }] },
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', context_window: 272000, input_modalities: ['text'] },
  ],
})

await test('a live listing replaces the fallback table', async () => {
  // Build the catalog against the stub so nothing touches the network.
  const s = await stub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(catalogBody)
  })
  const snapshot = await catalogAgainst(s.baseURL).snapshot()
  assert.equal(snapshot.live, true)
  assert.deepEqual([...snapshot.models.keys()], ['gpt-6-astra', 'gpt-5.5'])
  await s.stop()
})

await test('the catalog sends a client_version the backend requires', async () => {
  let seenUrl
  const s = await stub((req, res) => {
    seenUrl = req.url
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(catalogBody)
  })
  await catalogAgainst(s.baseURL, { clientVersion: () => '9.9.9' }).snapshot()
  await s.stop()
  assert.match(seenUrl, /client_version=9\.9\.9/)
})

await test('a discovered version is used when configuration names none', async () => {
  let seenUrl
  const s = await stub((req, res) => {
    seenUrl = req.url
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(catalogBody)
  })
  let discoveries = 0
  const catalog = catalogAgainst(s.baseURL, {
    clientVersion: () => '',
    discoverVersion: async () => {
      discoveries++
      return '8.8.8'
    },
  })
  await catalog.snapshot()
  await catalog.snapshot({ force: true })
  await s.stop()
  assert.match(seenUrl, /client_version=8\.8\.8/)
  // Discovery is a filesystem read; it must happen once, not per refresh.
  assert.equal(discoveries, 1)
})

await test('the literal default is used when discovery finds nothing', async () => {
  let seenUrl
  const s = await stub((req, res) => {
    seenUrl = req.url
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(catalogBody)
  })
  await catalogAgainst(s.baseURL, {
    clientVersion: () => '',
    discoverVersion: async () => undefined,
  }).snapshot()
  await s.stop()
  assert.match(seenUrl, new RegExp(`client_version=${DEFAULT_CLIENT_VERSION.replace(/\./g, '\\.')}`))
})

await test('a failed listing falls back to the curated table', async () => {
  const catalog = new CodexCatalog({
    resolveCredential: async () => {
      throw new Error('no credential')
    },
  })
  const snapshot = await catalog.snapshot()
  assert.equal(snapshot.live, false)
  assert.ok(snapshot.models.has('gpt-6-astra'))
  assert.match(snapshot.error.message, /no credential/)
})

await test('a cached snapshot is reused without refetching', async () => {
  let calls = 0
  const catalog = new CodexCatalog({
    resolveCredential: async () => {
      calls++
      throw new Error('nope')
    },
  })
  await catalog.snapshot()
  await catalog.snapshot()
  assert.equal(calls, 1)
})

console.log('\nadapter metadata')

/** Build an adapter over a credential stub. */
function makeAdapter(overrides = {}) {
  return new CodexAdapter({
    config: () => ({ ...Config({}), ...overrides.config }),
    resolveCredential: overrides.resolveCredential ?? (async () => {
      throw new Error('no credential')
    }),
    imageAccess: overrides.imageAccess,
  })
}

await test('providerInfo reports the display name', () => {
  const adapter = makeAdapter()
  assert.deepEqual(adapter.providerInfo(PROVIDER_ID), { id: PROVIDER_ID, name: DISPLAY_NAME })
})

await test('the route is mutable so a fallback claim is reflected', () => {
  const adapter = makeAdapter()
  assert.equal(adapter.route, PROVIDER_ID)
  adapter.route = FALLBACK_PROVIDER_ID
  assert.equal(adapter.route, FALLBACK_PROVIDER_ID)
})

await test('listModels reports modalities from the fallback catalog', async () => {
  const models = await makeAdapter().listModels()
  const astra = models.find((m) => m.id === 'gpt-6-astra')
  assert.deepEqual(astra.inputModalities, ['text', 'image'])
})

await test('resolveModel exposes context and reasoning levels', async () => {
  const resolved = await makeAdapter().resolveModel(PROVIDER_ID, 'gpt-6-astra')
  assert.equal(resolved.context.contextWindow, 272000)
  assert.ok(resolved.reasoning.efforts.some((e) => e.id === 'ultra'))
  assert.equal(resolved.systemPromptUpdate, 'in-history')
})

await test('resolveModel rejects an unknown model with UNKNOWN_MODEL', async () => {
  await assert.rejects(() => makeAdapter().resolveModel(PROVIDER_ID, 'nope'), (e) => e.code === 'UNKNOWN_MODEL')
})

await test('an unsupported reasoning effort is refused, not clamped', async () => {
  const adapter = makeAdapter()
  const stream = adapter.stream({
    provider: PROVIDER_ID,
    model: 'gpt-5.5',
    reasoningEffort: 'ultra',
    messages: [{ id: 'm', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }],
  })
  await assert.rejects(async () => {
    for await (const _ of stream) break
  }, (e) => e.code === 'UNSUPPORTED_REASONING_EFFORT')
})

await test('stop sequences are refused rather than ignored', async () => {
  const adapter = makeAdapter()
  const stream = adapter.stream({
    provider: PROVIDER_ID,
    model: 'gpt-6-astra',
    stop: ['END'],
    messages: [],
  })
  await assert.rejects(async () => {
    for await (const _ of stream) break
  }, (e) => e.code === 'UNSUPPORTED_OPTION')
})

await test('image input on a text-only model is refused', async () => {
  const adapter = makeAdapter()
  const stream = adapter.stream({
    provider: PROVIDER_ID,
    model: 'gpt-5.5',
    messages: [{ id: 'm', role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1 } }], source: { kind: 'user' } }],
  })
  await assert.rejects(async () => {
    for await (const _ of stream) break
  }, (e) => e.code === 'UNSUPPORTED_CONTENT')
})

await test('image input without the attachment service is refused clearly', async () => {
  const adapter = makeAdapter()
  const stream = adapter.stream({
    provider: PROVIDER_ID,
    model: 'gpt-6-astra',
    messages: [{ id: 'm', role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'a', mediaType: 'image/png', bytes: 1 } }], source: { kind: 'user' } }],
  })
  await assert.rejects(async () => {
    for await (const _ of stream) break
  }, (e) => e.code === 'UNSUPPORTED_CONTENT' && /attachment service/.test(e.message))
})

await test('an unknown model fails before any request', async () => {
  const adapter = makeAdapter()
  const stream = adapter.stream({ provider: PROVIDER_ID, model: 'ghost', messages: [] })
  await assert.rejects(async () => {
    for await (const _ of stream) break
  }, (e) => e.code === 'UNKNOWN_MODEL')
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
