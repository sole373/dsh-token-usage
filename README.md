# dsh-token-usage

> Token usage analytics and a model capability leaderboard — a DeepSeek Harness plugin.

It scans **the host's own session logs**, groups the records by provider and model,
and reports consumption trends, cache hit rates and per-model usage. It then lines
up **every model you can currently call** against a public capability leaderboard,
so you can see which of them is the strongest.

| Capability | Entry point |
| --- | --- |
| Usage panel | Sidebar "Token usage" → main panel (summary figures + four charts + a detail table) |
| Usage JSON | `GET {prefix}/usage` (supports `days=` and `refresh=1`) |
| Model leaderboard | Bottom of the usage panel (overall ranking + six task recommendations) |
| Leaderboard JSON | `GET {prefix}/model-rank` (supports `refresh=1`) |

**This plugin never touches your accounts.** It only reads the host's own session
logs: no OAuth flow, no credential copying, no model provider registration, no
changes to any client.

---

## How it relates to `dsh-agent-checkin`

**It doesn't.** The two plugins are fully independent and can be installed alone:

| | `dsh-agent-checkin` | `dsh-token-usage` |
| --- | --- | --- |
| What it does | Daily check-ins, credit balances, wiring local clients up as model providers | Token usage analytics, model capability leaderboard |
| Data source | The sign-in state of local clients | The host's own session logs |
| Reads the other one's files? | —— | **No** |

The usage panel used to live inside `dsh-agent-checkin` (0.8.0 and earlier). As of
0.9.0 it is a separate plugin: they share no code, no cache files, and never call
each other. Installing one has no effect on the other.

---

## Requirements

- DeepSeek Harness (`dsh`) 0.1.7 or newer, with a Web UI in the bundle
- Node.js `^22.19.0 || >=24.0.0`
- A readable local session log (default `$DSH_HOME/sessions`, or `~/.dsh/sessions`
  when `DSH_HOME` is unset)

---

## Installation

```bash
dsh plugin add @sole373/dsh-token-usage
```

Or add one line to the profile's `cordis.patch.yml`:

```yaml
- id: dsh-token-usage
  name: '@sole373/dsh-token-usage'
```

Restart DSH afterwards; a "Token usage" entry appears in the sidebar.

---

## Usage

### The usage panel

Click "Token usage" in the sidebar. From top to bottom the panel shows:

1. **Summary figures** — total consumption / today / last 7 days / call count, plus
   cache hits, cache misses and the hit rate
2. **Four charts** — consumption trend (bars; the time window — 7 / 30 / 90 days or
   "all" — lives in this card's corner and affects only this chart, alongside the
   daily / cumulative toggle), by-provider breakdown (donut), top models by usage,
   and a capability ranking of the models you actually used
3. **Source detail table** — per provider/model input, cache reads and writes,
   output, total, call count, hit rate, tokens per call and output share
4. **Model leaderboard** — an overall ranking (every scored model included; a model
   callable through several platforms is merged into one row with all platforms listed
   in the source column and the stats line noting "merged into N models"; 10 rows
   shown by default, scroll inside the table for the rest, row count in the corner)
   plus recommendations by task (coding / reasoning / agentic / long
   context / vision / best value), five per task
5. **Footer** — how many session files were scanned, how long it took, and whether
   the scan completed

The time window selector sits in the trend card's corner and only affects the trend
chart — summary figures, the donut, rankings and the detail table always cover the
full history. "Refresh" forces a re-scan; everything else uses the cache.

### How the numbers are computed

| Metric | Definition |
| --- | --- |
| Tokens per record | `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`, summed separately per segment |
| Hit rate denominator | `input + cacheRead + cacheWrite` (**excluding output** — output is generated, not fed in) |
| Zero denominator | Shows "—", **not 0%** ("couldn't read it" and "really zero" are different things) |
| Day boundary | Local time zone, not UTC |
| "Total" | All history; the three cache figures use the same baseline, so the numbers reconcile |

> **Why not the `totalTokens` field**: it is an older measure and is not guaranteed
> to match the sum of the four segments. Every total on the page is summed from the
> four segments.
>
> **Why only `assistant/message`**: `assistant/attempt` carries a copy of the same
> usage record; counting both would double the total for no reason.

### The incremental cache

Session logs only ever grow, so there is no reason to rescan everything each time.
The scanner records each file's `size + mtime` and only re-reads the files that
changed, reusing the previous row-level aggregation for the rest.

- Cold full scan: a few dozen logs / tens of MB, about 1.4 seconds
- Routine refresh: single-digit milliseconds once the cache is warm
- No SQLite: no native dependency, no schema migration, no half-written state

### The model leaderboard

The ranking draws on two sources, kept **strictly separate**:

- **Capability scores** — a public leaderboard (OpenRouter's `/api/v1/models`, no
  auth required, carrying Artificial Analysis's intelligence / coding / agentic
  indices plus context length, price and input modalities)
- **Scope** — **every model callable through this host right now**: the official
  `ctx.llm` (LlmRuntime) enumerates each registered provider's advertised models,
  so every enable/disable you make in "Platforms & Models" is reflected faithfully

So the board answers "of the models I can call, which one fits which task best".

> ⚠️ **Scope statement (printed on the panel, not hidden)**: the leaderboard only
> answers "what is this model's capability score", **not "are you allowed to call
> it"**. The callable catalog is the host's route roster, not an entitlement
> check — a model appearing here does not mean your account still has quota for it.

Two other `rankScope` values exist: `used` ranks only the models that **actually
appear** in your local session logs (including historical calls of models you no
longer use), and `all` ranks the entire public leaderboard (a view of the whole
world). If catalog enumeration fails, the rank panel reports "catalog unavailable"
honestly and **never** silently falls back to another scope.

### Leaderboard cache

The leaderboard changes on a daily scale, so polling it often just wastes network.
It is cached for 6 hours (configurable). The panel's "Refresh board" button always
bypasses the cache. A failed fetch is **not** fatal: the last good leaderboard
keeps being used, and the panel says so.

---

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `statusRoute` | `/dsh-token-usage` | HTTP prefix for the panel |
| `sessionsDir` | `''` | Session log root; empty means `$DSH_HOME/sessions` |
| `usageCacheSeconds` | `30` | Cache lifetime for scan results; the panel's "Refresh" always bypasses it |
| `rankCacheHours` | `6` | Leaderboard cache lifetime in hours |
| `rankScope` | `'catalog'` | `catalog` = every model callable through this host (default); `used` = only models actually used; `all` = the whole leaderboard |

---

## Honest reporting

- **Loopback only**: every endpoint accepts local loopback requests only. A Host
  outside loopback gets a 403; when an Origin is present it must be loopback too.
  This blocks "an external page using the browser to hit the local port".
- **No guessing**: a model with no leaderboard entry shows "—", not a score of 0;
  a zero hit-rate denominator shows "—", not 0%. "Couldn't read it" never looks
  like "read zero".
- **Incomplete scans say so**: a scan that hits its time budget is flagged as
  "this run did not finish", never passed off as complete.
- **The board only lists models callable through this host** (the default scope): it
  answers "what can I call right now", not "what exists in the world"; with
  `rankScope: used` it lists only the models you actually called.

---

## Design trade-offs

| Decision | Why | Cost |
| --- | --- | --- |
| Split multi-frame zstd by hand | A `session.v4.jsonl.zstd` is tens of thousands of independent frames back to back; `zstdDecompressSync` decompresses only the first one, **silently losing the other 99%** | We find frame boundaries ourselves via the `0xfd2fb528` magic |
| Only `assistant/message` counts | The usage in `attempt` duplicates the final record | `attempt` is used for de-duplication only |
| Never read `totalTokens` | The old field is not guaranteed to match the four-segment sum | The four segments are summed separately |
| In-memory cache, no SQLite | Logs only grow; the in-memory cache already brings routine refreshes down to single-digit milliseconds | One cold scan after a host restart; not shared across processes |
| Public API for leaderboard scores | Capability scores must be **someone else's measurements**, not our own estimates | Requires network; offline we reuse the last snapshot and say so |
| Scope = callable catalog | Answers "what can I call right now" and follows every Platforms & Models change | Depends on the host's LlmRuntime service; without it the panel reports "catalog unavailable" honestly |

---

## Licence

MIT
