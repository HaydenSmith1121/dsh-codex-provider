/**
 * Codex (ChatGPT) model provider for DeepSeek Harness.
 *
 * Mounting this plugin registers one LLM route whose backend is the ChatGPT
 * subscription API that the Codex CLI uses. It exists because that backend is
 * not reachable through a generic OpenAI-compatible route: it needs OAuth
 * session credentials rather than an API key, a mandatory `chatgpt-account-id`
 * header, and a Responses-shaped request body.
 *
 * The plugin contributes three things and nothing else:
 *
 * 1. an adapter serving the `codex` route (falling back to `codex-provider`
 *    when another adapter already owns the name),
 * 2. a settings-backed model discovery so the Settings → Models page can list
 *    what the backend actually serves,
 * 3. an entry in the configurable-provider directory, which is what draws the
 *    Codex row on that page.
 *
 * @module dsh-codex-provider
 */
import { Config } from './config.js'
import { CodexAdapter, DISPLAY_NAME, FALLBACK_PROVIDER_ID, PROVIDER_ID } from './adapter.js'
import { CodexCredentialSource, CredentialError, discoverClientVersion } from './auth.js'
import { LlmError } from './llm-error.js'
import { DEFAULT_BASE_URL, parseProxy } from './transport.js'
import { UsageService } from './usage.js'

/**
 * Recover the Codex home from the auth document path.
 * @param authPath - absolute path to `auth.json`.
 * @returns the containing directory.
 */
function authHomeOf(authPath) {
  const index = Math.max(authPath.lastIndexOf('/'), authPath.lastIndexOf('\\'))
  return index > 0 ? authPath.slice(0, index) : authPath
}

/** Settings namespace this plugin installs; the Web page edits this section. */
export const NS = 'llm-codex'

/**
 * Request-image target for this route.
 *
 * The backend does not publish a pixel or byte budget, so these are the values
 * the OpenAI vision endpoints have accepted historically: a 2048px long edge,
 * which preserves detail the model can actually use, under a 4 MiB encoded
 * ceiling that stays clear of request-size limits after base64 expansion.
 */
const IMAGE_TARGET = { width: 2048, height: 2048 }

/** Hard dependencies: the registry this plugin contributes to. */
export const inject = ['llm']

/**
 * Register the route, its discovery, and the usage surface.
 *
 * Configuration starts as the composition entry (`cordis.yml` / patch) and is
 * overridden field by field once the settings provider attaches.
 *
 * @param ctx - the plugin context.
 * @param raw - the composition-supplied configuration.
 */
export function apply(ctx, raw) {
  const entry = Config(raw)
  let current = () => entry

  const credentials = new CodexCredentialSource()

  // Describing the configuration failure beats failing at first request: the
  // user sees it while editing settings rather than minutes into a turn.
  ctx.logger.info(
    `llm-codex: route ${PROVIDER_ID} served from ${entry.baseURL}; credentials read from ${credentials.path}`,
  )

  const resolveCredential = async () => {
    try {
      return await credentials.resolve()
    } catch (error) {
      if (error instanceof CredentialError) {
        throw new LlmError(error.message, 'MISSING_CREDENTIAL', { cause: error })
      }
      throw error
    }
  }

  const adapter = new CodexAdapter({
    config: () => current(),
    resolveCredential,
    // The backend validates the reported client version, so prefer the locally
    // installed Codex version over the plugin's own literal default.
    discoverClientVersion: async () => {
      const discovered = await discoverClientVersion(authHomeOf(credentials.path))
      if (discovered !== undefined) {
        ctx.logger.info(`llm-codex: reporting client version ${discovered} (from the local Codex install)`)
      }
      return discovered
    },
    imageAccess: {
      /**
       * Resolve one attachment reference to inline base64 for the wire.
       *
       * `readImageRequest` returns the provider-ready encoded variant (resized
       * and re-encoded to fit the route's pixel and byte budget), so the bytes
       * sent are the same ones a text-only route would have been billed for.
       * @param ref - the durable attachment reference.
       * @returns media type plus base64 payload, or undefined when unreadable.
       */
      resolveInline: async (ref) => {
        const attachments = ctx.get('attachments')
        if (attachments === undefined) return undefined
        try {
          const version = await attachments.readImageRequest(ref, {
            width: IMAGE_TARGET.width,
            height: IMAGE_TARGET.height,
            maxBytes: current().maxRequestImageBytes,
          })
          return { mediaType: version.mediaType, base64: Buffer.from(version.data).toString('base64') }
        } catch (error) {
          ctx.logger.warn(`llm-codex: could not read an image attachment (${error?.message ?? String(error)})`)
          return undefined
        }
      },
    },
    onCatalogResolved: (snapshot) => {
      if (snapshot.live) {
        ctx.logger.info(`llm-codex: catalog resolved from the backend (${snapshot.listed} models served)`)
      } else {
        ctx.logger.warn(
          `llm-codex: the live catalog is unreachable, so the shipped fallback table is served (${snapshot.error?.message ?? 'no detail'})`,
        )
      }
    },
    onAuthRejected: () => {
      credentials.invalidate()
    },
    onOriginFailover: (origin, error) => {
      ctx.logger.warn(
        `llm-codex: ${origin} is unreachable (${error?.message ?? String(error)}), retrying against an alternate backend`,
      )
    },
  })

  let registration

  /**
   * Claim a route, preferring `codex` and falling back when another adapter
   * already owns it.
   *
   * `registerAdapter` is all-or-nothing, so a duplicate throws rather than
   * partially registering. Retrying under another id keeps the route usable
   * instead of losing it to whoever registered first.
   * @returns the registration handle, or undefined when no route was claimed.
   */
  const claimRoute = () => {
    for (const id of [PROVIDER_ID, FALLBACK_PROVIDER_ID]) {
      adapter.route = id
      try {
        return ctx.llm.registerAdapter([id], adapter)
      } catch (error) {
        if (error?.code === 'DUPLICATE_ADAPTER') continue
        throw error
      }
    }
    ctx.logger.warn(
      `llm-codex: both "${PROVIDER_ID}" and "${FALLBACK_PROVIDER_ID}" are already registered by other adapters, so this plugin serves nothing. Remove the conflicting adapter (a static model list under llm-pi-ai.providers is the usual cause) and restart.`,
    )
    return undefined
  }

  registration = claimRoute()
  if (registration !== undefined) {
    ctx.effect(() => () => registration())
  }

  // A directory entry is what draws the Codex row on Settings → Models. It is
  // claimed on the route actually served, because the directory rejects a
  // duplicate declaration and `codex` may already be declared elsewhere.
  if (registration !== undefined) {
    try {
      const directory = ctx.llm.registerConfigurableProviders([
        {
          provider: adapter.route,
          displayName: DISPLAY_NAME,
          settingsNs: NS,
          settingsPath: [],
        },
      ])
      ctx.effect(() => () => directory())
    } catch (error) {
      // A duplicate here must not take the route down with it; the route is the
      // capability, the directory row is only the editing surface.
      ctx.logger.warn(`llm-codex: could not register the configurable-provider row (${error?.message ?? String(error)})`)
    }
  }

  // Model discovery backs the "fetch available models" action on that page.
  try {
    const dispose = ctx.llm.registerModelDiscovery(NS, async () => {
      // Read the adapter's live catalog rather than re-deriving it, so the
      // draft and the served route agree.
      const models = await adapter.listModels()
      return models.map((model) => ({ id: model.id, name: model.name }))
    })
    ctx.effect(() => dispose)
  } catch (error) {
    // DUPLICATE_DISCOVERY is fatal when it escapes `apply`, because the loader
    // rethrows it from its own effect and the whole plugin tree fails to load.
    // Contain it: a duplicate only means another plugin owns this namespace.
    ctx.logger.warn(
      `llm-codex: model discovery for the settings namespace "${NS}" is already registered, so the fetch-models action stays with the other plugin (${error?.message ?? String(error)})`,
    )
  }

  // The usage surface reads the subscription's remaining allowance.
  ctx.plugin(UsageService, {
    baseURL: () => current().baseURL,
    resolveCredential,
  })

  // Settings: the composition entry is the base layer. The provider hands back
  // a thunk through `setSource` that is authoritative from then on — it returns
  // the resolved settings scope while one is attached and the composition entry
  // otherwise — so every dynamic read goes through it rather than through a
  // captured snapshot. Without a settings provider the entry stays in force and
  // the plugin is fully usable.
  let source = () => entry
  current = () => source()
  const settings = ctx.get('settings')
  if (settings !== undefined && typeof settings.installSection === 'function') {
    try {
      settings.installSection(ctx, NS, Config, entry, {
        setSource: (thunk) => {
          source = thunk
        },
        onChange: () => {
          // Nothing derived is cached beyond the catalog, which re-reads its own
          // configuration on the next resolution.
        },
      })
    } catch (error) {
      ctx.logger.warn(`llm-codex: settings section "${NS}" was not installed (${error?.message ?? String(error)})`)
    }
  }
}

export { Config } from './config.js'
export { DEFAULT_BASE_URL, parseProxy }
export { CodexAdapter, DISPLAY_NAME, FALLBACK_PROVIDER_ID, PROVIDER_ID }
export { CodexCredentialSource, CredentialError }
