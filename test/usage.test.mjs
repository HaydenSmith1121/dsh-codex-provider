// UsageService.read() behaviour.
//
// `normalizeUsage` is covered in catalog.test.mjs, but the service itself was
// not — and its central contract is that usage is *decorative*: a failure must
// return undefined rather than throw into the UI. That promise is worth a test,
// because breaking it turns a missing pill into a broken session.
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { UsageService, originOf } from '../lib/usage.js'

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
    res.end(JSON.stringify({
      rateLimits: { primary: { usedPercent: 42, resetsAt: 1789813175, windowDurationMins: 300 }, planType: 'plus' },
    }))
  })
  const usage = await h.service.read()
  await h.stop()
  assert.equal(usage.windows.primary.usedPercent, 42)
  assert.equal(usage.planType, 'plus')
  assert.equal(usage.windows.primary.windowMinutes, 300)
})

await test('resetsAt is Unix seconds and becomes an ISO instant', async () => {
  const h = await withService((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ rateLimits: { primary: { usedPercent: 1, resetsAt: 1789813175 } } }))
  })
  const usage = await h.service.read()
  await h.stop()
  // 1789813175s -> 2026-09-19T18:19:35.000Z
  assert.equal(usage.windows.primary.resetsAt, new Date(1789813175 * 1000).toISOString())
  assert.match(usage.windows.primary.resetsAt, /^2026-/)
})

await test('the multi-bucket view wins over the single backward-compatible one', async () => {
  const h = await withService((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      rateLimits: { primary: { usedPercent: 1 } },
      rateLimitsByLimitId: {
        codex: { primary: { usedPercent: 10 }, planType: 'plus' },
        'gpt-5.6-codex': { primary: { usedPercent: 20 } },
      },
    }))
  })
  const usage = await h.service.read()
  await h.stop()
  assert.deepEqual(Object.keys(usage.buckets), ['codex', 'gpt-5.6-codex'])
  assert.equal(usage.buckets.codex.windows.primary.usedPercent, 10)
})

await test('both windows of a bucket are read', async () => {
  const h = await withService((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      rateLimits: {
        primary: { usedPercent: 30, windowDurationMins: 300 },
        secondary: { usedPercent: 70, windowDurationMins: 10080 },
      },
    }))
  })
  const usage = await h.service.read()
  await h.stop()
  assert.equal(usage.windows.primary.usedPercent, 30)
  assert.equal(usage.windows.secondary.usedPercent, 70)
  assert.equal(usage.windows.secondary.windowMinutes, 10080)
})

await test('a refusal reason and exhaust flag survive normalization', async () => {
  const h = await withService((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      ordinaryUsageAllowed: false,
      rateLimits: { primary: { usedPercent: 100 }, rateLimitReachedType: 'rate_limit_reached' },
    }))
  })
  const usage = await h.service.read()
  await h.stop()
  assert.equal(usage.exhausted, true)
  assert.equal(usage.buckets.default.reachedType, 'rate_limit_reached')
})

await test('an unlimited account is flagged so no meter is drawn', async () => {
  const h = await withService((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ rateLimits: { primary: { usedPercent: 0 }, credits: { unlimited: true, hasCredits: true } } }))
  })
  const usage = await h.service.read()
  await h.stop()
  assert.equal(usage.buckets.default.unlimited, true)
})

await test('the request path is host-root-relative, not under the API base', async () => {
  const seen = []
  // The resolver returns the stub's origin with the real API base path appended,
  // which is exactly what a user's configured baseURL looks like.
  const server = createServer((req, res) => {
    seen.push(req.url)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"rateLimits":{"primary":{"usedPercent":1}}}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const ctx = new Context()
  const service = new UsageService(ctx, {
    baseURL: () => `http://127.0.0.1:${server.address().port}/backend-api/codex`,
    resolveCredential: async () => ({ accessToken: 't', accountId: 'a' }),
  })
  await service.read()
  await new Promise((r) => server.close(r))
  // A naive join would request `/backend-api/codex/api/codex/usage`.
  assert.deepEqual(seen, ['/api/codex/usage'])
})

await test('originOf reduces a base URL to scheme+host', () => {
  assert.equal(originOf('https://chatgpt.com/backend-api/codex'), 'https://chatgpt.com')
  assert.equal(originOf('https://chatgpt.com/backend-api/codex/'), 'https://chatgpt.com')
  assert.equal(originOf('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080')
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
