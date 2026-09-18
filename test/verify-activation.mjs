// Definitive activation check: mount the plugin exactly as the harness loader
// does, with every host service it touches, and report what it registered.
//
// Why this rather than probing the running harness over HTTP: the plugin is
// host-side and contributes no client surface, so there is no route to curl.
// Composing it here exercises the same `apply()` the loader calls, against the
// same real `LlmRuntime`, settings provider, and credentials path.
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import * as plugin from '../lib/index.js'

/** In-memory settings provider, so the namespace install path is exercised. */
class MemorySettings extends SettingsProvider {
  writable = true
  constructor(ctx) {
    super(ctx)
    this.doc = {}
  }
  async load() { return this.doc }
  async persist(ns, section) {
    this.doc = { ...this.doc, [ns]: section }
    this.publish(this.doc)
  }
}

const ctx = new Context()
ctx.plugin(LlmRuntime)
ctx.plugin(MemorySettings)
await new Promise((r) => setTimeout(r, 250))

const logs = []
for (const level of ['info', 'warn', 'error']) {
  const original = ctx.logger[level].bind(ctx.logger)
  ctx.logger[level] = (m, ...rest) => { logs.push([level, String(m)]); return original(m, ...rest) }
}

ctx.plugin({
  inject: ['llm'],
  apply(inner) { plugin.apply(inner, {}) },
})
await new Promise((r) => setTimeout(r, 500))

console.log('=== registered ===')
console.log('route           :', ctx.llm.listProviders().map((p) => `${p.id}="${p.name}"`).join(', ') || '(none)')
console.log('configurable    :', ctx.llm.listConfigurableProviders().map((p) => `${p.provider} ns=${p.settingsNs}`).join(', ') || '(none)')
console.log('settings ns     :', ctx.get('settings').describe().map((d) => d.ns).join(', ') || '(none)')

console.log('\n=== plugin logs ===')
for (const [level, m] of logs) console.log(`  [${level}] ${m.slice(0, 200)}`)

console.log('\n=== live catalog through the route ===')
try {
  const models = await ctx.llm.listModels('codex')
  console.log('models:', models.map((m) => m.id).join(', '))
  const info = await ctx.llm.resolveModelInfo('codex', models[0].id)
  console.log('context:', info.context?.contextWindow, '| efforts:', info.reasoning?.efforts.map((e) => e.id).join('/'))
} catch (error) {
  console.log('FAILED:', error.code, error.message.slice(0, 200))
}

console.log('\n=== settings round-trip ===')
const settings = ctx.get('settings')
await settings.update('llm-codex', { refreshMinutes: 9 })
console.log('refreshMinutes after write:', settings.get('llm-codex').refreshMinutes)
