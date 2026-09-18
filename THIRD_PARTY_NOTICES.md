# Third-party notices

This package is an independent adapter. It contains no third-party source code;
it interoperates with services and packages owned by others.

## Runtime dependencies

- **`@deepseek-ai/schemastery`** — MIT. Settings schema validation.

## Peer dependencies (provided by the host harness)

- **`@deepseek-ai/cordis`** — MIT. Plugin runtime.
- **`@deepseek-ai/dsh-llm`** — MIT. The `LlmAdapter` contract this package
  implements.
- **`@deepseek-ai/dsh-attachment`** — MIT, optional. Image resolution; the
  plugin degrades gracefully when it is absent.

## Interoperated services

- **OpenAI Codex / ChatGPT backend** (`chatgpt.com/backend-api/codex`). This
  package is not affiliated with, endorsed by, or supported by OpenAI. It reads
  a session file produced by the Codex CLI (`~/.codex/auth.json`, read-only) and
  speaks the same wire protocol that CLI uses.

  Use of this package is subject to your own agreement with OpenAI, including
  any subscription terms and acceptable-use policies. You are responsible for
  confirming that your use complies with them.

- **DeepSeek Harness** — the host application this plugin extends.

## Design notes

The adapter, transport, and protocol conversion in this package were written
against the harness's published `LlmAdapter` contract and the observed wire
behaviour of the Codex backend. The structural approach — a settings-backed
provider plugin that registers one LLM route, a curated fallback catalog
intersected with a live listing, and a route-claim fallback when another adapter
owns the preferred name — follows
[`dsh-opencode-go-plus`](https://github.com/HaydenSmith1121/dsh-opencode-go-plus),
which solves the same class of problem for a different gateway. No code was
copied from it; the shared ideas are the plugin shape, not the implementation.
