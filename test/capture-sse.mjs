// Capture the real Responses SSE frames by making the transport print them.
//
// Binary string-table archaeology proved unreliable: the packing splits names
// at boundaries that no simple matcher can reassemble, and successive attempts
// produced contradictory readings. The wire is the authority, so this runs the
// plugin's own transport against the real endpoint and dumps every frame
// verbatim — including on the error path, where the backend's SSE error shape
// is itself useful evidence.
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { codexRequest } from '../lib/transport.js'

const auth = JSON.parse(readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8'))
const frames = []

const payload = {
  model: 'gpt-5.6-luna',
  instructions: 'You are a terse assistant.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: PROBE_OK' }] }],
  stream: true,
  store: false,
}

console.log('=== requesting /responses with raw frame capture ===')
const res = await codexRequest({
  path: '/responses',
  method: 'POST',
  accessToken: auth.tokens.access_token,
  accountId: auth.tokens.account_id,
  body: JSON.stringify(payload),
  timeoutMs: 60_000,
  onSse: (frame) => frames.push(frame),
})

console.log(`status: ${res.status}`)
console.log(`content-type: ${res.headers['content-type']}`)
console.log(`sse frames: ${frames.length}`)
console.log(`body bytes: ${res.body.length}`)

if (frames.length > 0) {
  console.log('\n--- frames ---')
  for (const f of frames.slice(0, 20)) console.log(f.slice(0, 300))
} else {
  console.log('\n--- raw body (no SSE frames; likely an error response) ---')
  console.log(res.body.slice(0, 1200))
}

writeFileSync('D:/deepseek/.tmp/sse-capture.json', JSON.stringify({
  status: res.status,
  headers: res.headers,
  frames,
  bodyHead: res.body.slice(0, 4000),
}, null, 2), 'utf8')
console.log('\nwrote D:/deepseek/.tmp/sse-capture.json')
