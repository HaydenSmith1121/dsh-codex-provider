// Unit test: auth module. Uses a fake session file and a fake token endpoint,
// so it never touches the real ~/.codex/auth.json.
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strict as assert } from 'node:assert'
import {
  CodexCredentialSource,
  CredentialError,
  accountIdOf,
  authPath,
  decodeJwtPayload,
  tokenExpiryMs,
} from '../lib/auth.js'

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

/** Build an unsigned JWT with the given payload. */
function jwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

const dir = await mkdtemp(join(tmpdir(), 'codex-auth-test-'))
const sessionPath = join(dir, 'auth.json')
const now = 1_700_000_000_000

const futureJwt = jwt({ exp: Math.floor(now / 1000) + 3600 })
const pastJwt = jwt({ exp: Math.floor(now / 1000) - 3600 })

function writeSession(obj) {
  return writeFile(sessionPath, JSON.stringify(obj), 'utf8')
}

console.log('auth.js')

await test('decodes a JWT payload', () => {
  assert.equal(decodeJwtPayload(futureJwt).exp, Math.floor(now / 1000) + 3600)
})

await test('returns undefined for a non-JWT', () => {
  assert.equal(decodeJwtPayload('not-a-jwt'), undefined)
  assert.equal(decodeJwtPayload(undefined), undefined)
})

await test('reads token expiry in ms', () => {
  assert.equal(tokenExpiryMs(futureJwt), (Math.floor(now / 1000) + 3600) * 1000)
})

await test('account id comes from tokens.account_id', () => {
  assert.equal(accountIdOf({ tokens: { account_id: 'acct-1' } }), 'acct-1')
})

await test('account id falls back to the id_token claim', () => {
  const id = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-2' } })
  assert.equal(accountIdOf({ tokens: { id_token: id } }), 'acct-2')
})

await test('authPath honours CODEX_HOME', () => {
  assert.equal(authPath({ CODEX_HOME: 'D:\\custom' }), join('D:\\custom', 'auth.json'))
})

await test('missing file produces an actionable error', async () => {
  const src = new CodexCredentialSource({ path: join(dir, 'nope.json') })
  await assert.rejects(() => src.resolve(), (e) => e instanceof CredentialError && /codex login/.test(e.message))
})

await test('API-key login is reported, not silently accepted', async () => {
  await writeSession({ OPENAI_API_KEY: 'sk-x', tokens: {} })
  const src = new CodexCredentialSource({ path: sessionPath })
  await assert.rejects(() => src.resolve(), (e) => /carries no access token/.test(e.message))
})

await test('a valid unexpired token is used without refreshing', async () => {
  await writeSession({ tokens: { access_token: futureJwt, account_id: 'acct-1', refresh_token: 'rt.1.x' } })
  let refreshCalls = 0
  const src = new CodexCredentialSource({
    path: sessionPath,
    now: () => now,
    fetchImpl: async () => { refreshCalls++; throw new Error('should not refresh') },
  })
  const cred = await src.resolve()
  assert.equal(cred.accessToken, futureJwt)
  assert.equal(cred.accountId, 'acct-1')
  assert.equal(refreshCalls, 0)
})

await test('an expired token triggers a refresh and caches the result', async () => {
  await writeSession({ tokens: { access_token: pastJwt, account_id: 'acct-1', refresh_token: 'rt.1.x' } })
  const fresh = jwt({ exp: Math.floor(now / 1000) + 7200 })
  let refreshCalls = 0
  const src = new CodexCredentialSource({
    path: sessionPath,
    now: () => now,
    fetchImpl: async (url, init) => {
      refreshCalls++
      const body = JSON.parse(init.body)
      assert.equal(body.grant_type, 'refresh_token')
      assert.equal(body.refresh_token, 'rt.1.x')
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: fresh, refresh_token: 'rt.2.y', expires_in: 3600 }) }
    },
  })
  const first = await src.resolve()
  assert.equal(first.accessToken, fresh)
  // Second resolve must reuse the cache rather than refresh again.
  const second = await src.resolve()
  assert.equal(second.accessToken, fresh)
  assert.equal(refreshCalls, 1)
})

await test('concurrent resolves collapse into one refresh', async () => {
  await writeSession({ tokens: { access_token: pastJwt, account_id: 'acct-1', refresh_token: 'rt.1.x' } })
  const fresh = jwt({ exp: Math.floor(now / 1000) + 7200 })
  let refreshCalls = 0
  const src = new CodexCredentialSource({
    path: sessionPath,
    now: () => now,
    fetchImpl: async () => {
      refreshCalls++
      await new Promise((r) => setTimeout(r, 20))
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: fresh, expires_in: 3600 }) }
    },
  })
  const results = await Promise.all([src.resolve(), src.resolve(), src.resolve()])
  assert.equal(refreshCalls, 1)
  for (const r of results) assert.equal(r.accessToken, fresh)
})

await test('a rejected refresh names codex login', async () => {
  await writeSession({ tokens: { access_token: pastJwt, account_id: 'acct-1', refresh_token: 'rt.dead' } })
  const src = new CodexCredentialSource({
    path: sessionPath,
    now: () => now,
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => '{"error":"invalid_grant"}' }),
  })
  await assert.rejects(() => src.resolve(), (e) => /HTTP 401/.test(e.message) && /codex login/.test(e.message))
})

await test('invalidate forces a re-read', async () => {
  await writeSession({ tokens: { access_token: futureJwt, account_id: 'acct-1' } })
  const src = new CodexCredentialSource({ path: sessionPath, now: () => now })
  await src.resolve()
  src.invalidate()
  // Rewrite with a different account; invalidate must make it visible.
  const other = jwt({ exp: Math.floor(now / 1000) + 3600 })
  await writeSession({ tokens: { access_token: other, account_id: 'acct-9' } })
  const cred = await src.resolve()
  assert.equal(cred.accountId, 'acct-9')
})

await rm(dir, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
