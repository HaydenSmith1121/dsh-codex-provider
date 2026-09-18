// The origin's path prefix must be joined with the request path exactly once,
// for every shape of baseURL a user might configure.
//
// This started as a probe: two different baseURLs appeared to produce the same
// request line, which would have meant the origin path was being dropped or
// doubled. It turned out to be a labelling coincidence in the probe itself, but
// the join is easy to break and a broken join silently sends every request to
// the wrong path, so it is kept as a regression test.
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { codexRequest } from '../lib/transport.js'

const seen = []
const server = createServer((req, res) => {
  seen.push(`${req.method} ${req.url}`)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{"ok":true}')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const origin = `http://127.0.0.1:${port}`

const CASES = [
  { baseURL: `${origin}/backend-api/codex`, path: '/usage', want: 'GET /backend-api/codex/usage' },
  { baseURL: `${origin}/backend-api`, path: '/codex/usage', want: 'GET /backend-api/codex/usage' },
  { baseURL: `${origin}/backend-api/codex`, path: '/models?client_version=1.2.3', want: 'GET /backend-api/codex/models?client_version=1.2.3' },
  { baseURL: `${origin}/`, path: '/models', want: 'GET /models' },
  { baseURL: origin, path: '/models', want: 'GET /models' },
  { baseURL: `${origin}/backend-api/codex/`, path: '/responses', want: 'GET /backend-api/codex/responses' },
]

let passed = 0
let failed = 0
for (const c of CASES) {
  const label = `${c.baseURL.replace(origin, '') || '(bare)'} + ${c.path}`
  try {
    await codexRequest({ baseURL: c.baseURL, path: c.path, method: 'GET', accessToken: 't', accountId: 'a', timeoutMs: 10_000 })
    const got = seen[seen.length - 1]
    assert.equal(got, c.want)
    passed++
    console.log(`  ok   ${label.padEnd(50)} -> ${got}`)
  } catch (error) {
    failed++
    console.log(`  FAIL ${label.padEnd(50)} ${error.message}`)
  }
}
await new Promise((r) => server.close(r))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
