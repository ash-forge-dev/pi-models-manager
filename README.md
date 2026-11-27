# models-manager

A pi extension that puts your own endpoint's model list on one screen, so you stop
hand-editing JSON across several files.

```
pi → /mm
┌ Models · local-endpoint ──────────────────── 3/3 in cycle · auth ok ┐
│   model                             ctx     out  RVAD              │
│ ▸ ● vendor::chat                    1.0M   100k  RVA·              │
│   ● * vendor::reasoner              262k    50k  R·A·              │
│   ○   vendor/big-model              262k    50k  R·A·              │
├─────────────────────────────────────────────────────────────────────┤
│ vendor::chat                                        overrides: none│
│  name        vendor::chat                                           │
│  context     1048576                                                │
│  maxTokens   100000                                                 │
│  reasoning   yes                                                    │
│  vision      yes                                                    │
└─────────────────────────────────────────────────────────────────────┘
```

Column flags, left to right: `●`/`○` in or out of the Ctrl+P cycle, `*` has
overrides, `R` reasoning, `V` vision, `A` usable (credentials resolve), `D` the model
`/model` would start with (read-only). The same legend sits on the last line of the
models screen, so it is never a guess.

## Why

Your endpoint's model list lives in several places, and each one wants JSON by hand:

| File | Holds |
| --- | --- |
| `~/.pi/agent/models.json` | connection (`baseUrl`, `apiKey`, `api`, `compat`, `headers`), `models[]`, `modelOverrides` |
| `~/.pi/agent/settings.json` | `enabledModels` (Ctrl+P scope + startup), `defaultProvider`/`defaultModel` |
| `auth.json` | credentials written by `/login` |
| an extension (optional) | a `refreshModels` hook that supplies the model list |
| `models-store.json` | pi's own catalog cache — never touched by this tool |

This extension edits the first two, using only formats pi already understands.
Nothing is stored in a private file, so removing the extension leaves your config
intact and readable.

## Install

This is a normal pi package: a `package.json` with a `pi.extensions` manifest, no
dependencies to install. Pick whichever suits you.

**Clone it into place** — simplest, and edits take effect with `/reload`:

```bash
git clone https://github.com/ash-forge-dev/pi-models-manager.git \
  ~/.pi/agent/extensions/pi-models-manager
# project-local instead (one repo only): clone into .pi/extensions/
```

**Let pi manage it as a package source** — records it in `settings.json`, updates
with `pi update --extensions`:

```bash
pi install git:github.com/ash-forge-dev/pi-models-manager
```

The repository is currently **private**, so that command needs your GitHub
credentials (the `gh` credential helper set up earlier covers it). Anyone else can
use it once the repo is public.

**From a local clone, without copying or tracking it**:

```bash
pi install ./pi-models-manager
```

**Not on npm.** `pi install npm:pi-models-manager` will not work until the package
is actually published, which requires an npm account and the name being free.

All of these load the same way: pi resolves the directory through
`package.json → pi.extensions`, and falls back to `index.ts` if the manifest is
missing. After changing the code run `/reload` in pi.

`PI_CODING_AGENT_DIR` relocates the agent directory; the tests use it to run
against a throwaway sandbox.

## Portability

- No npm dependencies. It imports only the modules pi injects into every extension:
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and
  `@earendil-works/pi-ai/providers/all`.
- Provider-agnostic: nothing is hardcoded to this machine, and there is no
  provider id in the code. Endpoints are whatever appears in `models.json` /
  extension registrations.
- `test/loader.mjs` proves the packaged form loads by running pi's **own** loader
  (`discoverAndLoadExtensions`), not a hand-rolled bundler setup.

pi APIs relied on (check these when moving to a much older or newer pi):

| Used for | API |
| --- | --- |
| provider/model listing, auth status | `ctx.modelRegistry.getAll/getAvailable/getProviderAuthStatus/getRegisteredProviderIds` |
| applying changes live | `ctx.modelRegistry.refresh({ allowNetwork, providers, force })` |
| resolving a probe's base URL + key | `getApiKeyAndHeaders(model)`, `getApiKeyForProvider(id)` |
| the screen | `ctx.ui.custom(factory, { blocked })`, `Input`, `matchesKey`, `Key`, `truncateToWidth`, `visibleWidth`, `wrapTextWithAnsi` |
| config location | `getAgentDir()` |
| built-in provider detection | `getBuiltinProviders()` from `@earendil-works/pi-ai/providers/all` (returns id strings; there is a static fallback list) |

## Keys

Models screen:

| Key | Action |
| --- | --- |
| `↑` `↓` | move in the model list |
| `tab` / `enter` | move between the list and the field form |
| `enter` (form) | edit the field (an input opens with the current value) |
| `space` | list: enable/disable the model in the cycle scope · form: toggle/cycle the value |
| `←` `→` | cycle a boolean/enum field |
| `shift ↑` `shift ↓` | reorder the model inside the cycle scope |
| `r` | re-run discovery against the endpoint |
| `e` | open the endpoint (connection + compat) form |
| `n` | create a new provider block |
| `v` | run checks (config, credentials, `GET /models`, one chat ping) |
| `x` | list: clear all overrides for the model · form: reset the focused field |
| `/` | filter the list by id/name |
| `[` `]` | switch endpoint |
| `esc` / `q` | back one level / close |

Endpoint screen (`e`):

| Key | Action |
| --- | --- |
| `↑` `↓` / `enter` | move / edit a connection or compat field |
| `space` `←` `→` | cycle booleans and enums (e.g. `api`, `thinkingFormat`) |
| `all ctx` / `all maxTokens` | write that value into `modelOverrides` for every model of the endpoint |
| `x` | reset the focused field to inherited |
| `D` then `D` | delete this endpoint: removes its `models.json` block and its cycle-scope patterns (any other key cancels) |
| `v` | run checks for this endpoint |

Editing notes:

- Text fields (`name`, `baseUrl`, `apiKey`, `headers`, thinking levels) open
  **prefilled**: `ctrl+u` clears the line, and an empty submit removes the override
  so the value falls back to whatever the discovered model provides.
- Numeric fields (`contextWindow`, `maxTokens`, `cost.*`) open **blank** with the
  current value as a placeholder, because appending digits to `1234` is never what
  you meant. An empty submit leaves the value alone; use `x` to reset it.

## Discovery

For custom providers that nothing else registers, the manager fetches
`GET <baseUrl>/models` itself on `session_start` and maps the result. So a bare
provider block is enough:

```json
{ "providers": { "my-endpoint": { "baseUrl": "http://localhost:8000/v1", "api": "openai-completions" } } }
```

Mapping is generic — no per-endpoint code. It reads what the server reports:

| pi field | Source (first match wins) |
| --- | --- |
| `id` / `name` | `id`, then `display_name` / `name`; unloaded models get a `(not loaded)` suffix |
| `contextWindow` | `loaded_context_length`, `context_length`, `max_context_length`, … |
| `maxTokens` | `max_output_tokens` / `maxTokens`, else the fallback below |
| `reasoning` + `thinkingLevelMap` | `reasoning.supported_efforts` / `default_enabled` / `mandatory`, or a `reasoning`/`thinking` capability |
| `input` | `vision` or a `vision`/`image` capability → `["text","image"]` |
| skipped | an explicit non-chat `kind` such as `embedding` |

Everything else falls back to **32768 context / 16384 output**, deliberately
conservative: over-claiming context makes pi send a request the model cannot take
(hard failure), while under-claiming only compacts slightly early. A plain
OpenAI-compatible endpoint that reports only model ids therefore needs two numbers
per endpoint, not a TypeScript file:

- endpoint form → **`all ctx`** and **`all maxTokens`** write those values into
  `modelOverrides` for every discovered model in one action;
- any single model can then be corrected on the models screen, and per-model
  overrides always win.

**Precedence**, lowest to highest: built-in catalog → `models.json` `models[]` →
another extension's `refreshModels` → this tool's discovery → `modelOverrides`.

This tool only registers a provider when nothing else has: if another extension
already registers it (a hand-written discovery `.ts`, for example), that extension
keeps ownership and nothing changes. Delete that file and the manager takes over —
no per-endpoint code required.

## What gets written

**Per-model metadata** goes to `models.json` →
`providers.<id>.modelOverrides.<modelId>`:

```json
{
  "providers": {
    "local-endpoint": {
      "baseUrl": "http://localhost:8000/v1",
      "api": "openai-completions",
      "apiKey": "…",
      "compat": { "supportsStore": false, "thinkingFormat": "qwen-chat-template" },
      "modelOverrides": {
        "vendor::chat": { "maxTokens": 100000, "reasoning": true },
        "vendor/big-model": {
          "contextWindow": 262144,
          "thinkingLevelMap": { "minimal": null, "low": "low" }
        }
      }
    }
  }
}
```

`modelOverrides` is the right target because pi's provider composer applies it
**last** — after the built-in catalog, `models[]` entries, and models supplied by
an extension's `refreshModels`. So your tuning survives rediscovery, and editing it
by hand still works.

Editable fields: `name`, `contextWindow`, `maxTokens`, `reasoning`, `input`
(vision), `cost.*`, and each `thinkingLevelMap` level (a provider value, `null` for
unsupported, or inherit).

**Connection settings** go in the provider block next to it: `name`, `baseUrl`,
`api`, `apiKey` (literal, `$VAR`, or `!command`), `authHeader`, `headers`, and the
`compat` flags pi documents for that API. `compat` also has a raw JSON field for
anything the form does not list.

**Cycle scope** goes to `settings.json`:

```json
{
  "enabledModels": [
    "local-endpoint/vendor::chat",
    "local-endpoint/vendor::reasoner",
    "anthropic/*"
  ]
}
```

`/mm` writes `enabledModels` only. The **default model is not its business**: it is
whatever `/model` last saved with `Ctrl+S`, and `/mm` only *displays* which model
that is (the `D` flag). One writer, so the two can never disagree.

An empty or missing `enabledModels` means "no scoping: every usable model". The
first time you disable a single model, the list is materialized: the edited
provider gets explicit `provider/id` entries in display order, and every other
provider with usable models collapses to `provider/*`. That keeps the file short
and preserves Ctrl+P order for the endpoint you are working on.

Model ids containing colons are safe: `:level` is only treated as a
thinking-level suffix when the tail is a real level name (`local-endpoint/vendor::chat`
is one id, `anthropic/*:high` pins a level).

## Checks

`v` reports, in order: `models.json` / `settings.json` parse state, registry load
errors, project-settings shadowing, endpoint URL/API, resolved credential source,
model counts, whether the highlighted model is usable and in scope, then live
`GET <baseUrl>/models` and a one-shot chat completion (so a model that is listed but
cannot answer shows up as an error instead of a mystery).

## Safety

- Writes are read-modify-write: unknown keys (`piGuiCustomEndpoint`, `packages`,
  `$schema`, …) and key order are preserved.
- Every change that alters bytes first copies the file to
  `models.json.bak-YYYYMMDD-HHmmss` / `settings.json.bak-…`, keeping the newest 20.
- Writes go to a temp file and are renamed over the target, preserving the file's
  permissions (config files may hold an API key).
- A file that fails to parse is never overwritten; the parse error is shown instead.
- Built-in catalog providers are excluded, so this cannot damage subscription
  provider defaults. A provider pi ships with is skipped even if it appears in
  `models.json`.
- `models-store.json` is never touched.

## Caveats

- The cycle scope takes effect for **new** sessions. After changing it, `/reload`
  (or restart) applies it to the current session; the extension says so on exit.
- There is no "default endpoint": endpoints are just a list you switch between with
  `[` `]`, ordered by id.
- `settings.json` writes are safe while pi runs (pi re-reads the file and merges
  only the fields it modified), but if you also change `enabledModels` with
  `/scoped-models` in the same session, the last writer wins.
- A project `.pi/settings.json` that sets `enabledModels` overrides the global list.
  The checks screen flags this.
- `apiKey` is shown masked (`test...3456`); editing it opens the full value. A
  literal key is stored in plain text in `models.json` — prefer `$ENV_VAR` or
  `!command`.

## Tests

Three headless suites, no terminal required:

```bash
cd ~/.pi/agent/extensions/models-manager
npm test          # discovery + headless + loader + portability
```

`test/headless.mjs` loads the extension through jiti, points
`PI_CODING_AGENT_DIR` at a throwaway directory, and drives the real TUI component
with scripted keystrokes. It asserts, among other things: an edit writes only the
intended `modelOverrides` key while preserving `compat`, unknown keys and
`settings.json` fields; resetting a field removes the override entry; disabling one
model materializes `enabledModels` without losing other providers; `x`/`d`/`shift↑↓`/
`/`/`v` do what the footer says; `GET /models` and the chat probe report failures; a
corrupt `models.json` is refused rather than overwritten; and no rendered line
exceeds its width from 40 to 160 columns.

`test/discovery.mjs` serves a metadata-rich `/v1/models` payload and a minimal
OpenAI-compatible one from a real HTTP server, then asserts the mapping: loaded vs
declared context length, vision, reasoning efforts → pi thinking levels, non-chat
kinds skipped, duplicate ids deduped, conservative fallbacks, and 401/unreachable/
missing-baseUrl reported instead of thrown.

`test/loader.mjs` checks the package shape and loads the extension with pi's real
loader, asserting both commands register, the `session_start` discovery hook is
added, and no tools are registered.

Both refuse to run unless pi resolved an agent dir under the temp directory, and
both delete their sandbox on exit. Pass a `node_modules` path as `argv[2]` or set
`PI_TEST_INSTALL` if pi is not in a layout they can find.
