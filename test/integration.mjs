// Integration check: mount the plugin in a real harness context.
//
// This drives the actual `apply()` against the real Cordis loader and the real
// dsh-llm registry, with only the Codex backend stubbed. It answers the one
// question unit tests cannot: does the plugin mount, claim a route, and stream
// through the harness's own adapter contract?
import { createServer } from 'node:http'

const stub = createServer((req, res) => {
  if (req.url.startsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      models: [
        {
          slug: 'gpt-6-astra',
          display_name: 'GPT-6-Astra',
          context_window: 272000,
          input_modalities: ['text', 'image'],
          supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }],
          default_reasoning_level: 'low',
        },
      ],
    }))
    return
  }
  if (req.url.startsWith('/responses')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      { type: 'response.created', response: { id: 'r1', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'm1' } },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: 'integration ok' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm1', content: [{ type: 'output_text', text: 'integration ok' }] } },
      { type: 'response.completed', response: { id: 'r1', status: 'completed', usage: { input_tokens: 10, output_tokens: 3 } } },
    ]
    for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`)
    res.end()
    return
  }
  res.writeHead(404).end('{}')
})
await new Promise((r) => stub.listen(0, '127.0.0.1', r))
const baseURL = `http://127.0.0.1:${stub.address().port}`

// Import the real harness runtime pieces from the installed dsh.
const { Context } = await import('@deepseek-ai/cordis')
const LlmRuntime = (await import('@deepseek-ai/dsh-llm')).default
const plugin = await import('../lib/index.js')

const ctx = new Context()
// Mount the LLM registry first; the plugin injects it.
ctx.plugin(LlmRuntime)
await new Promise((r) => setTimeout(r, 50))

console.log('registry providers before:', ctx.llm.listProviders().map((p) => p.id))

ctx.plugin({
  inject: ['llm'],
  apply(inner) {
    plugin.apply(inner, { baseURL, refreshMinutes: 60 })
  },
})
await new Promise((r) => setTimeout(r, 200))

const providers = ctx.llm.listProviders()
console.log('registry providers after :', providers.map((p) => p.id))
const served = providers.find((p) => p.id === 'codex')
console.log('codex route registered   :', served !== undefined, served?.name ?? '')

const models = await ctx.llm.listModels('codex')
console.log('listModels               :', models.map((m) => m.id).join(', '))
console.log('inputModalities          :', JSON.stringify(models[0]?.inputModalities))

const info = await ctx.llm.resolveModelInfo('codex', 'gpt-6-astra')
console.log('contextWindow            :', info.context?.contextWindow)
console.log('reasoning efforts        :', info.reasoning?.efforts.map((e) => e.id).join(', '))
console.log('systemPromptUpdate       :', info.systemPromptUpdate)

const configurable = ctx.llm.listConfigurableProviders()
console.log('configurable providers   :', configurable.map((p) => `${p.provider}(${p.settingsNs})`).join(', '))

// Stream through the runtime, exactly as the agent loop would.
const chunks = []
for await (const chunk of ctx.llm.stream({
  provider: 'codex',
  model: 'gpt-6-astra',
  messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'say hi' }], source: { kind: 'user' } }],
})) {
  chunks.push(chunk)
}
console.log('stream chunk types       :', chunks.map((c) => c.type).join(','))
console.log('stream text              :', JSON.stringify(chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')))
console.log('stream finish            :', JSON.stringify(chunks.at(-1)))

await new Promise((r) => stub.close(r))
console.log('\nINTEGRATION OK')
process.exit(0)
