# Verification record

What was actually run, and what it proved.

## Environment

| Item | Value |
|---|---|
| Harness CLI | `dsh 0.1.6-alpha.1` (alpha channel) |
| Node | `v24.14.0` (`D:\tools\nodejs`) |
| Isolation | `DSH_HOME` pointed at a scratch directory; production harness untouched |
| Credential | ChatGPT Plus session at `~/.codex/auth.json`, read-only |
| Network | `HTTPS_PROXY=http://127.0.0.1:7897` (Clash) |

## Offline suite

```sh
npm test
```

```
auth.test.mjs       13 passed, 0 failed
catalog.test.mjs    42 passed, 0 failed
convert.test.mjs    39 passed, 0 failed
e2e.test.mjs        10 passed, 0 failed
settings.test.mjs    5 passed, 0 failed
─────────────────────────────────────
ALL 5 TEST FILES PASSED   (109 assertions)
```

## Header and version probing

Reasoning about the wire contract from documentation was not good enough, so
each assumption was tested against the live endpoint. `/models` does not consume
quota, which makes it usable as a probe target while the account is rate-limited.

**Which headers are load-bearing.** Each was removed in turn:

```
/models with each header removed in turn:

all headers (baseline)                         OK
- chatgpt-account-id                           OK
- originator                                   OK
- version                                      OK
- OpenAI-Beta                                  OK
- user-agent                                   OK
- all optional headers                         OK

Is client_version load-bearing on /models?
no client_version query                        400 — missing query client_version

Is the Authorization header load-bearing?
no bearer token                                401 — missing_end_user_auth
```

Conclusions, all of which corrected an earlier assumption:

- **Only `Authorization` gates the request.** The remaining headers are
  advisory on this route.
- **`client_version` is a required query parameter**, not optional — omitting
  it is a hard 400.
- **`OpenAI-Beta` is not validated.** Any value is accepted, including none.
  The plugin sends `responses_websockets=2026-02-06` because that is what the
  installed Codex CLI binary actually sends, so the request is
  indistinguishable from a first-party client — not because the backend
  requires that specific string. (An earlier revision sent
  `responses=experimental`, the value the public Responses API documents; that
  works too, but it is not what this backend's own client sends.)

**Client version discovery.** Because `client_version` is validated, a
hardcoded literal ages out silently across Codex upgrades. The plugin now reads
the version from the local installation — `models_cache.json` first, then the
installed `@openai/codex` manifest — and reports that:

```
codex home     : C:\Users\Administrator\.codex
plugin default : 0.155.0
discovered     : 0.155.0
```

Configuration (`llm-codex.clientVersion`) overrides discovery when set.
Discovery is a filesystem read and happens once per catalog instance, not once
per refresh; a test asserts that.

## Live backend checks

`node test/live-transport.mjs`

```
auth   : resolved (account <redacted>)
proxy  : {"host":"127.0.0.1","port":7897}
/models status: 200
models: gpt-6-astra, gpt-reserve, gpt-5.6-sol, gpt-5.6-terra,
        gpt-5.6-luna, gpt-5.5, codex-auto-review
sample: {"slug":"gpt-6-astra","context_window":272000,
         "max_context_window":872000,
         "efforts":["low","medium","high","xhigh","max","ultra"],
         "modalities":["text","image"],"display":"GPT-6-Astra"}
```

This proves credential resolution, the CONNECT tunnel, TLS, the required
headers, and response framing against the real endpoint.

`/responses` returned **HTTP 429 `usage_limit_reached`** throughout
development — the subscription allowance was exhausted by prior use, with the
backend reporting a reset about 26 hours out. That is the backend's own
accounting, not a defect: the plugin classifies it as `QUOTA` with a reset hint
rather than treating it as a retryable rate limit.

> **Consequence for this record:** a full text turn against the *real* backend
> has not been observed. Everything up to and including the response status line
> has. The stream translation itself is covered by `e2e.test.mjs` against a stub
> replaying the real wire shape, and by `integration.mjs` through
> `ctx.llm.stream()`. A live conversational check remains outstanding until the
> allowance resets.

## Harness integration

`node test/integration.mjs` — the plugin mounted in a real Cordis context with
the real `LlmRuntime`:

```
registry providers before: []
registry providers after : [ 'codex' ]
codex route registered   : true Codex (ChatGPT)
listModels               : gpt-6-astra, gpt-reserve, gpt-5.6-sol,
                           gpt-5.6-terra, gpt-5.6-luna, gpt-5.5,
                           codex-auto-review
inputModalities          : ["text","image"]
contextWindow            : 272000
reasoning efforts        : low, medium, high, xhigh, max, ultra
systemPromptUpdate       : in-history
configurable providers   : codex(llm-codex)
stream chunk types       : block-start,text-delta,block-end,usage,finish
stream text              : "integration ok"
stream finish            : {"type":"finish","reason":{"kind":"stop"}}
```

A full turn through the harness's own streaming API, from message in to finish
chunk out.

## Isolated harness boot

```sh
DSH_HOME=<scratch> dsh plugin --profile web add <package>
DSH_HOME=<scratch> dsh web --port 3099 --no-open
```

- The profile's `dsh.profile.bundles` gained `dsh-codex-provider`.
- `dsh --dump-config --profile web` ended with:

  ```yaml
  # == dsh-codex-provider
  - id: llm-codex
    name: dsh-codex-provider
  ```

- `dsh web` booted to a URL with **no error** — the plugin tree loaded, which
  is the failure mode a broken provider plugin usually produces.

The production harness on its own `DSH_HOME` was never written to.

## Bugs found and fixed during development

Recorded because each was caught by a test rather than by inspection:

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | Tool-call turn reported as an empty response | `#sawToolCall` only set on `output_item.added` | Also set it on `output_item.done` |
| 2 | Content silently dropped when a stream ended early | A block opened but never closed by `output_item.done` was never emitted | Accumulate deltas and close dangling blocks in `end()` |
| 3 | `prettifyModelName` produced `Gpt-5.6-Luna` | Naive capitalisation | Preserve known initialisms |
| 4 | Every local test hit a TLS handshake error | Transport always wrapped in TLS | Apply TLS only for `https:` |
| 5 | `adapter.prepareCall is not a function` | Adapter was a plain class, not an `LlmAdapter` subclass | Extend `LlmAdapter` |
| 6 | Settings namespace never registered | Guessed `settings.install()`; the real API is `installSection(owner, ns, schema, entry, {setSource, onChange})` | Use the real signature and read through the `setSource` thunk |
| 7 | Stub backend unreachable, `HTTP 0` | `HTTPS_PROXY` routed loopback through Clash | Never proxy loopback/private hosts |
| 8 | Response status stayed `0` against a local peer | Listeners attached *after* `socket.write`; a fast peer answered in the same tick | Attach listeners before writing |
| 9 | Raw `ECONNREFUSED` reached the harness untyped | Socket errors not wrapped | Wrap connect and TLS failures in typed `LlmError`s |
| 10 | `client_version` hardcoded to a stale literal | Assumed optional; probing showed a 400 when absent | Discover the version from the local Codex install, overridable by config |
| 11 | Cancelling a stream hung for the full 120s idle timeout | The abort listener was detached once the socket connected, so an abort arriving mid-stream never reached it | Keep the listener for the whole request; detach only when the exchange finishes |

Items 10 and 11 were found by probing and by a test that started failing for the
right reason — not by inspection.


## Reproducing

```sh
# offline, no credentials needed
npm test

# live (requires an unexhausted ChatGPT subscription and a working proxy)
node test/live-transport.mjs
node test/integration.mjs
```
