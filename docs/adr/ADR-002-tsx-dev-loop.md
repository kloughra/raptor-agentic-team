# ADR-002: Use `tsx` for the development MCP server entry point

- **Status:** Accepted
- **Date:** 2026-05-03
- **Sprint:** 9 (`dev-loop-rebuild-friction`)
- **Spec:** [docs/specs/dev-loop-rebuild-friction.md](../specs/dev-loop-rebuild-friction.md)
- **Architecture:** [docs/architecture/dev-loop-rebuild-friction.md](../architecture/dev-loop-rebuild-friction.md)

## Context

Raptor's inner dev loop required three steps:

1. Edit `src/*.ts`
2. Run `npm run build` (TypeScript → `dist/`)
3. `/mcp` reconnect to respawn the server

If step 2 was skipped, Claude Code respawned the **old** compiled JS from
`dist/` with no warning. This silent-stale-execution failure mode bit the
dogfooding workflow at least twice in late April 2026 (after PR #13 stdin fix
and PR #14 permission allowlist), each time costing minutes of debugging
before "did I rebuild?" surfaced.

A local interim mitigation (option B) was put in place: `.mcp.json` was
rewritten to a bash wrapper that ran `npm run build --silent` before launching
the node process. That eliminated the missed-build failure mode at the cost
of ~3–5s per reconnect, but it was bash-only (Windows-incompatible) and
remained untracked because it was a per-developer hack.

## Decision

Adopt `tsx` (https://github.com/privatenumber/tsx) as a `devDependency` and
switch the development MCP entry point in `.mcp.json` to launch
`src/index.ts` directly via `npx tsx`. There is no `dist/` dependency in the
dev loop; on every `/mcp` reconnect, `tsx` performs an on-the-fly compile
from current source.

Production semantics are unchanged: `npm run build` still produces
`dist/src/index.js`, `package.json#bin.raptor` still points there, and end
users who `npm install raptor` continue to receive compiled JS.

## Alternatives considered

- **(A) Background `npx tsc --watch`** — smallest change, no per-reconnect
  overhead, but easy to forget the watcher and silently regress. Rejected as
  footgun-prone.
- **(B) `.mcp.json` bash wrapper that runs `npm run build`** — eliminates
  the missed-build failure mode at ~3–5s per reconnect. Adopted as interim
  local config 2026-04-28. Rejected as the canonical fix because it's
  bash-only (no Windows / non-bash shells), slower than necessary, and
  doesn't eliminate the `dist/` dependency.
- **`ts-node`** — older, slower (uses the TypeScript compiler vs. esbuild),
  and we already use `ts-jest` for tests so we're not adopting `ts-node`-style
  transformer infrastructure.
- **`bun`** — would require a new runtime install. Out of scope.
- **`node --loader ts-node/esm` / `node --experimental-strip-types`** — both
  have rough edges for stdio-MCP-server use cases (loader API is unstable;
  native strip-types is too new and doesn't handle all syntax).

## Consequences

### Positive

- **Edit-to-runtime is one step.** Edits to `src/**/*.ts` are picked up on
  the next `/mcp` reconnect — no manual `npm run build`.
- **Stale `dist/` cannot silently shadow a source edit.** The dev entry
  point never reads from `dist/`.
- **Cross-platform.** `command: "npx"` + `args: ["tsx", "src/index.ts"]` is
  shell-agnostic; no bash one-liner.
- **Compile errors are visible.** `tsx` exits non-zero on compile failure
  → Claude Code's MCP log surfaces the error rather than running stale
  code.
- **`.mcp.json` is checked in.** Path-portable (`cwd: "."`); every
  developer gets the benefit by default.

### Negative / accepted trade-offs

- **First-boot perf.** `tsx` JIT-compiles on each reconnect (~hundreds of
  ms with esbuild). Comparable to or faster than today's
  `npm run build && node` (~3–5s).
- **One additional devDependency.** `tsx` plus its small transitive set
  (esbuild, etc.) — dev-only, not shipped to consumers.
- **Migration friction.** Existing developers with the option-B `.mcp.json`
  will get a git conflict on pull. Resolution is documented in the sprint
  summary (`git checkout .mcp.json` to accept the new tracked version).

### Neutral

- `npm run build`, `tsconfig.json`, `package.json#bin`, `package.json#main`,
  Jest config, and the `start` script are all **unchanged**. No production
  code change. End-user installs are unaffected.

## Implementation notes

- `tsx` pinned at `^4.x` (caret on the latest stable major at time of
  install).
- `.mcp.json` shape: `command: "npx"`, `args: ["tsx", "src/index.ts"]`,
  `cwd: "."`. Using `npx` (vs. a direct binary path like
  `./node_modules/.bin/tsx`) gives a recognizable "missing dependency →
  clear `npm install` hint" if `tsx` isn't installed.
- New npm scripts:
  - `dev`: `tsx src/index.ts` — equivalent to the `.mcp.json` invocation,
    for direct shell use.
  - `dev:smoke`: `tsx scripts/dev-smoke.ts` — boot-smoke check that spawns
    `npx tsx src/index.ts`, closes stdin, and asserts no crash-before-ready
    signals appear in stderr.
- `dist/` remains gitignored. Stale `dist/` on disk is harmless because the
  dev loop no longer reads it.

## Out of scope

- Replacing `tsc` for production builds.
- Watch-mode tests.
- Hot-reload without `/mcp` reconnect.
- Scaffolding `package.json` / `.mcp.json` into projects bootstrapped via
  Raptor (the bundled template currently emits neither file; see the
  architecture doc for the no-op rationale).
