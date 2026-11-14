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
kt-mcp-login           # ask for e-mail + password, store them, check the login
bin/kt-mcp-stdio       # stdio server; OpenCode and Claude start this themselves
npm start              # the upstream HTTP + OAuth server (needs .env, PUBLIC_URL…)
```

`kt-mcp-login` (`bin/kt-mcp-login`, linked into `~/.local/bin`) prompts with the
password hidden, quotes whatever characters it gets, writes
`~/.config/kt-mcp/env` with mode 600 and then calls `scripts/check-login.mjs`,
which starts the stdio server and asks for today's summary, so a wrong password
is reported immediately. Re-running it just replaces the file.

OpenCode config: the `kt` server in `~/.config/opencode/opencode.jsonc`, tools
named `kt_*`, denied everywhere except the `fitness` workspace
(`~/projects/fitness/opencode.json` allows them). Check with
`opencode mcp list` → `kt connected`.

Claude Code: `.mcp.json` in `~/projects/fitness` (main session) and inline
`mcpServers` in `~/.claude/agents/fitness-coach.md` (sub-agent), tools named
`mcp__kt__*`. Any Claude run outside the fitness folder needs its own server
entry; the login file is shared.

Fork: `maprokes/kt-mcp` was created on 2026-11-14 with `gh repo fork`, and
`main` is pushed to it over SSH.

## Updating later

```sh
git fetch upstream                       # upstream = https://github.com/stany9g/kt-mcp.git
git log --oneline origin/main..upstream/main
git merge upstream/main
npm test
git push origin main                     # origin = git@github.com:maprokes/kt-mcp.git (SSH)
```

The local stdio files (`src/stdio.ts`, `src/mcp/server.ts`, `bin/kt-mcp-stdio`,
this file) are the only divergence from upstream besides the three merges.
`src/stdio.ts` points `console.log` at stderr, because the tool guard logs with
it and stdout carries the protocol.

Verified 2026-11-14: `npm test` 18/18, `opencode mcp list` → `kt connected`,
`search_food` returns live results from kaloricketabulky.cz. Logged-in tools
(`get_day_summary`, `log_food`) still returned a login error because
`~/.config/kt-mcp/env` held placeholders at that point.
