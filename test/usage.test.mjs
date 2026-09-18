// UsageService.read() behaviour.
//
// `normalizeUsage` is covered in catalog.test.mjs, but the service itself was
// not — and its central contract is that usage is *decorative*: a failure must
// return undefined rather than throw into the UI. That promise is worth a test,
// because breaking it turns a missing pill into a broken session.
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { UsageService } from '../lib/usage.js'

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

/** Mount a UsageService over a stub origin. */
async function withService(handler, options = {}) {
  const server = createServer((req, res) => {
    if (handler === undefined) { res.destroy(); return }
    handler(req, res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const ctx = new Context()
  const service = new UsageService(ctx, {
    baseURL: () => options.baseURL ?? `http://127.0.0.1:${server.address().port}`,
    resolveCredential: options.resolveCredential ?? (async () => ({ accessToken: 't', accountId: 'a' })),
  })
  return { service, stop: () => new Promise((r) => server.close(r)) }
}

console.log('usage service')

await test('a well-formed payload is normalized', async () => {
  const h = await withService((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ primary: { used_percent: 42, resets_at: '2026-09-19T10:00:00Z' }, plan_type: 'plus' }))
  })
  const usage = await h.service.read()
  await h.stop()
  assert.equal(usage.windows.primary.usedPercent, 42)
  assert.equal(usage.planType, 'plus')
})

await test('requests the configured path', async () => {
  const seen = []
  const h = await withService((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"primary":{"used_percent":1}}')
  })
  await h.service.read()
  await h.stop()
  assert.deepEqual(seen, ['/usage'])
})

await test('a non-200 answer yields undefined, not a throw', async () => {
  const h = await withService((req, res) => {
    res.writeHead(403, { 'content-type': 'text/html' })
    res.end('<html>blocked</html>')
  })
  assert.equal(await h.service.read(), undefined)
  await h.stop()
})

await test('an HTML body does not crash the parse', async () => {
  const h = await withService((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html><body>not json</body></html>')
  })
  assert.equal(await h.service.read(), undefined)
  await h.stop()
})

await test('a payload with no recognizable windows yields undefined', async () => {
  const h = await withService((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ unrelated: true }))
  })
  assert.equal(await h.service.read(), undefined)
  await h.stop()
})

await test('an unreachable endpoint yields undefined', async () => {
  const h = await withService(undefined, { baseURL: 'http://127.0.0.1:1' })
  assert.equal(await h.service.read(), undefined)
  await h.stop()
})

await test('a missing credential yields undefined without a request', async () => {
  let requests = 0
  const h = await withService(
    (req, res) => { requests++; res.writeHead(200).end('{}') },
    {
      resolveCredential: async () => { throw new Error('no codex session') },
    },
  )
  assert.equal(await h.service.read(), undefined)
  assert.equal(requests, 0)
  await h.stop()
})

await test('a slow endpoint does not hang the caller forever', async () => {
  const h = await withService((req, res) => {
    // Accept the request and never answer.
  })
  const started = Date.now()
  assert.equal(await h.service.read(), undefined)
  // The service sets its own 15s timeout; this asserts it is bounded, not hung.
  assert.ok(Date.now() - started < 30_000, 'read() should be bounded by its own timeout')
  h.stop()
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
