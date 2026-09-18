# Architecture

One plugin, four layers, each independently testable.

```
lib/index.js       apply(): registers the route, discovery, directory row, usage service
  ├── lib/adapter.js    LlmAdapter implementation; orchestrates one stream call
  │     ├── lib/catalog.js     model discovery from the live endpoint
  │     ├── lib/convert.js     harness messages <-> Responses API items
  │     └── lib/stream.js      Responses SSE events -> harness StreamChunks
  ├── lib/auth.js       Codex session credentials (read-only, in-memory refresh)
  ├── lib/transport.js  HTTP/1.1 over a CONNECT tunnel; SSE framing
  ├── lib/usage.js      subscription allowance surface
  └── lib/config.js     settings schema
```

## Why each layer exists

### `transport.js` — because `fetch` cannot do this job

Node's global `fetch`:

- ignores `HTTPS_PROXY` unless a dispatcher is installed, and installing one
  would mean depending on `undici` internals or a proxy-agent package;
- resolves `chatgpt.com` through the system resolver, which is poisoned on a
  censored network.

So the transport performs the HTTP CONNECT handshake itself, then speaks
HTTP/1.1 over the resulting socket, framing by `content-length`, chunked
transfer, or EOF. It also streams SSE frames to a callback as they arrive, which
is what lets chunks reach the harness while the backend is still generating.

Two behaviours are deliberate and tested:

- **Loopback is never proxied.** A developer pointing `baseURL` at a local
  gateway must not have that request sent to a proxy that cannot reach their
  machine.
- **TLS only for `https:`.** A plain-HTTP endpoint stays cleartext; wrapping it
  in TLS fails with an opaque handshake error instead of a usable one.

### `auth.js` — because the credential is not an API key

The Codex CLI signs in with a ChatGPT subscription and stores an OAuth session
at `~/.codex/auth.json`. This module reads that file, reads `exp` off the access
token itself (not the file's `last_refresh`, which records when a refresh last
happened rather than whether the result is still valid), and refreshes in memory
when the token is expired or about to be.

**It never writes back.** The file belongs to the Codex CLI; a second writer
could break the user's own Codex installation. The rotated token serves this
process until it exits. Concurrent refreshes collapse into one in-flight
rotation, and `invalidate()` after a 401 forces the next call to re-read the
session rather than replaying a dead token.

### `catalog.js` — because the listing is authoritative

Unlike most OpenAI-compatible gateways, `/models` here returns context window,
supported reasoning efforts, input modalities, and a display name. The catalog
therefore *is* the live listing; the shipped table is only a fallback so the
selector is never empty offline or on a cold start.

A snapshot is cached for `refreshMinutes`. A failed refresh keeps the last good
snapshot rather than emptying the selector; only a catalog that has never been
fetched falls back to the shipped table.

### `convert.js` — because the request shape differs

The Responses API takes a flat `input` array of typed items with a top-level
`instructions` string. The harness hands over ordered `Message` values with
content blocks. Three mappings carry real subtlety:

1. **Tool results** are their own `user`-role message in the harness but a
   `function_call_output` item on the wire, correlated by call id — not by
   position.
2. **Assistant tool calls** must be replayed as `function_call` items *before*
   the results answering them, with `arguments` as a JSON string.
3. **Usage is disjoint in the harness.** `inputTokens` excludes cached input,
   while Responses reports one `input_tokens` total that already includes it, so
   the cached count is subtracted. Getting this wrong silently double-bills.

### `stream.js` — because the stream vocabularies differ

Responses emits a flat sequence of typed events; the harness wants
index-addressed blocks that open, accumulate, and close. The translator
maintains one harness block per (item, content) pair and assigns indexes itself,
because reasoning-summary and text events can share an item index while being
different blocks.

Two invariants it enforces:

- **A call delivered only as `output_item.done` still counts as content.** A
  stream that emits `done` without `added` would otherwise be misread as an
  empty response.
- **Dangling blocks are closed at end-of-stream.** The backend can end without
  `output_item.done` for every item; leaving a block open would silently drop
  content, because the harness assembles from `block-end`.

It also refuses to call an empty completion a success — that becomes
`EMPTY_RESPONSE`, which the retry policy treats as safe to repeat.

### `adapter.js` — the generation boundary

Extends the harness `LlmAdapter` base so the inherited `prepareCall` binds one
catalog generation's model metadata to the stream that follows. Every dynamic
fact (configuration, credential, catalog) is read through a callback at call
time, so a settings change reaches the next request without a restart.

An explicit reasoning effort the model does not offer is **refused, not
clamped** — silently downgrading a caller's request is worse than failing.

## Registration order

`apply()` claims things in a deliberate order, because one of them is fatal if
it escapes:

1. **The route** (`registerAdapter`). Falls back to `codex-provider` when
   another adapter owns `codex`.
2. **The directory row** (`registerConfigurableProviders`). Wrapped in its own
   try/catch: a duplicate must not take the route down with it, since the route
   is the capability and the row is only the editing surface.
3. **Model discovery** (`registerModelDiscovery`). Wrapped because
   `DUPLICATE_DISCOVERY` thrown from `apply()` is rethrown from the loader's own
   effect and **fails the entire plugin tree** — every plugin in the profile,
   not just this one.
4. **Settings** (`installSection`), which hands back a thunk that becomes the
   authoritative configuration source.

## Testing strategy

Offline, deterministic, no network:

- each module's pure functions are tested directly;
- the adapter is tested end-to-end against a stub backend replaying captured
  SSE frames;
- the plugin is mounted in a real Cordis context with a real `LlmRuntime` and a
  real settings provider, then streamed through `ctx.llm.stream()`.

Live, opt-in, requires an unexhausted subscription:

- `test/live-transport.mjs` — real credentials, real catalog, real SSE;
- `test/integration.mjs` — mount and stream against the real backend.

The live checks found the header requirements and the catalog shape; the
offline tests found the transport, stream, and settings bugs. Both matter.
