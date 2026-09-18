// Live check: transport + auth against the real Codex backend.
// Read-only; prints request metadata but never credentials.
import { CodexCredentialSource } from '../lib/auth.js'
import { codexRequest, proxyFor } from '../lib/transport.js'

const source = new CodexCredentialSource()
const { accessToken, accountId } = await source.resolve()

console.log('auth   : resolved (account', accountId, ')')
console.log('proxy  :', JSON.stringify(proxyFor(process.env, 'chatgpt.com')) ?? 'direct')

// 1. Model catalog — cheap, and proves auth + routing + headers.
try {
  const res = await codexRequest({
    path: '/models?client_version=0.154.0',
    method: 'GET',
    accessToken,
    accountId,
    timeoutMs: 60_000,
  })
  console.log('\n/models status:', res.status)
  if (res.status === 200) {
    const parsed = JSON.parse(res.body)
    console.log('models:', parsed.models.map((m) => m.slug).join(', '))
    const first = parsed.models[0]
    console.log('sample:', JSON.stringify({
      slug: first.slug,
      context_window: first.context_window,
      max_context_window: first.max_context_window,
      efforts: first.supported_reasoning_levels?.map((l) => l.effort),
      modalities: first.input_modalities,
      display: first.display_name,
      visibility: first.visibility,
    }))
  } else {
    console.log('body:', res.body.slice(0, 500))
  }
} catch (error) {
  console.log('\n/models FAILED:', error.code, error.message)
}

// 2. A minimal streaming turn — proves SSE framing end to end.
const payload = JSON.stringify({
  model: 'gpt-5.6-luna',
  instructions: 'You are a terse assistant.',
  input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly: PROBE_OK' }] }],
  stream: true,
  store: false,
})
try {
  const seen = []
  const res = await codexRequest({
    path: '/responses',
    method: 'POST',
    accessToken,
    accountId,
    body: payload,
    timeoutMs: 60_000,
    onSse: (d) => {
      const ev = JSON.parse(d)
      seen.push(ev.type)
      if (seen.length <= 3) console.log('  sse:', ev.type)
    },
  })
  console.log('\n/responses status:', res.status, '| sse frames:', res.sse.length)
  if (res.status === 200) {
    console.log('event types:', [...new Set(seen)].join(', '))
    const text = res.sse
      .map((d) => JSON.parse(d))
      .filter((e) => e.type === 'response.output_text.delta')
      .map((e) => e.delta)
      .join('')
    console.log('TEXT DELTA:', JSON.stringify(text))
  } else {
    console.log('body:', res.body.slice(0, 500))
  }
} catch (error) {
  console.log('\n/responses FAILED:', error.code, error.message)
}

process.exit(0)
