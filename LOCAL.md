# Local setup (Martin's fork)

This clone at `~/projects/kt-mcp` is Martin's copy of
[stany9g/kt-mcp](https://github.com/stany9g/kt-mcp) with three upstream pull
requests merged, plus a local stdio entrypoint so OpenCode can run the server
without HTTPS, OAuth or a Cloudflare tunnel.

## What was merged

| PR | What it adds | Why it matters here |
|---|---|---|
| [#2](https://github.com/stany9g/kt-mcp/pull/2) | `get_day_entries`, `get_logged_days`, `get_period_analysis` | Reading the diary back: what was eaten, which days were logged, and per-day averages with the foods behind each macro. This is what the weekly review needs. |
| [#3](https://github.com/stany9g/kt-mcp/pull/3) | Drinks default to millilitres, tools mention drinks | Without it, logging water failed with *Potravinu se nepodařilo zapsat*. |
| [#1](https://github.com/stany9g/kt-mcp/pull/1) | `log_weight` | Body weight into the KT history, for the chart there. |

Merge commits: `737083e` (#2), `0769ba1` (#3), `d2d7801` (#1). The only
conflicts were adjacent additions in `src/kt/client.test.ts`, `src/kt/client.ts`,
`src/mcp/tools.ts`, `src/index.ts` and the two READMEs; both sides were kept and
`npm test` passes (18 tests).

## Local addition: stdio entrypoint

Upstream only ships the hosted HTTP + OAuth server (`src/index.ts`, needs a
public HTTPS URL). For local use OpenCode starts the server over stdio instead:

- `src/stdio.ts` — same tools, `KT_EMAIL`/`KT_PASSWORD` from the environment.
- `src/mcp/server.ts` — the shared `McpServer` (name, instructions, tools) both
  entrypoints use, so they cannot drift.
- `bin/kt-mcp-stdio` — wrapper that sources `~/.config/kt-mcp/env` and runs
  `dist/stdio.js`.

Credentials live in `~/.config/kt-mcp/env` (chmod 600, outside the repo):

```sh
KT_EMAIL=you@example.com
KT_PASSWORD=your-password
```

## Running it

```sh
npm run build          # tsc -> dist/
npm test               # build + 18 tests
bin/kt-mcp-stdio       # stdio server; OpenCode starts this itself
npm start              # the upstream HTTP + OAuth server (needs .env, PUBLIC_URL…)
```

OpenCode config: the `kt` server in `~/.config/opencode/opencode.jsonc`, tools
named `kt_*`, denied everywhere except the `fitness` workspace
(`~/projects/fitness/opencode.json` allows them). Check with
`opencode mcp list` → `kt connected`.

## Updating later

```sh
git fetch upstream          # after `git remote add upstream https://github.com/stany9g/kt-mcp.git`
git log --oneline origin/main..upstream/main
git merge upstream/main
npm test
```

The local stdio files (`src/stdio.ts`, `src/mcp/server.ts`, `bin/kt-mcp-stdio`,
this file) are the only divergence from upstream besides the three merges.
