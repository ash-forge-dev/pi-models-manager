# pi-models-manager

Manage the models of your own pi endpoints from one screen, instead of editing
JSON across several files.

```
pi → /mm
┌ Models · local-endpoint ──────────────────── 3/3 in cycle · auth ok ┐
│   model                             ctx     out  RVAD              │
│ ▸ ● vendor::chat                    1.0M   100k  RVA·              │
│   ● * vendor::reasoner              262k    50k  R·A·              │
│   ○   vendor/big-model              262k    50k  R·A·              │
├─────────────────────────────────────────────────────────────────────┤
│ vendor::chat                                        overrides: none│
│  context     1048576                                                │
│  maxTokens   100000                                                 │
└─────────────────────────────────────────────────────────────────────┘
```

`●` in cycle · `○` not · `*` overridden · `R` reasoning · `V` vision · `A` usable
· `D` default

## Install

```bash
git clone https://github.com/ash-forge-dev/pi-models-manager.git \
  ~/.pi/agent/extensions/pi-models-manager
```

Then `/reload` in pi. No dependencies, no build step. `.pi/extensions/` instead for
one project. Needs your GitHub credentials while the repo is private. Not on npm.

## Use

`/mm` opens the screen. Add an endpoint with `n` (id + baseUrl) and its models are
discovered automatically.

| Key | |
| --- | --- |
| `↑` `↓` | move |
| `tab` / `enter` | list ↔ fields |
| `enter` | edit value |
| `space` | cycle scope (list) / toggle value (field) |
| `shift ↑↓` | reorder in the cycle |
| `[` `]` | switch endpoint |
| `e` | endpoint settings |
| `n` | new endpoint |
| `v` | run checks |
| `x` | clear overrides |
| `/` | filter |
| `D` `D` | delete endpoint (in endpoint screen) |
| `esc` / `q` | back / close |

## What it writes

- `~/.pi/agent/models.json` → `providers.<id>`. Per-model values go in
  `modelOverrides`, which pi applies last, so they survive rediscovery.
- `~/.pi/agent/settings.json` → `enabledModels`, the Ctrl+P cycle and its order.

That's it — no private config file. The default model is left to `/model`; `/mm`
only displays it.

For custom endpoints nothing else registers, `/mm` fetches `GET <baseUrl>/models`
and maps what the server reports. Missing limits fall back to 32768 context /
16384 output; fix them with `all ctx` / `all maxTokens` in the endpoint screen.

## Safety

- Read-modify-write: unknown keys and file permissions are preserved.
- A file that fails to parse is never overwritten.
- Built-in providers are never touched.

## Tests

```bash
npm test
```

Four headless suites. No credentials or terminal needed; each runs against a
throwaway agent dir.
