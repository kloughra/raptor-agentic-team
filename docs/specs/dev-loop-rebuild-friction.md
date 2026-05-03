---
slug: dev-loop-rebuild-friction
status: ready
sprint: 9
---

# Dev Loop Rebuild Friction — Eliminate the Build-Reconnect-Forget Loop

## User Story

As a Raptor maintainer dogfooding the project, I want changes to `src/*.ts` to take effect on the next `/mcp` reconnect without a manual `npm run build` step, so that I stop silently testing stale compiled JS after edits.

## Overview

Today, the inner dev loop for Raptor is:

1. Edit `src/*.ts`
2. Run `npm run build` (TypeScript → `dist/`)
3. `/mcp` reconnect to respawn the server

If step 2 is skipped, Claude Code respawns the **old** compiled JS from `dist/` with no warning. The edit appears live in the source tree but is invisible at runtime. This bit the dogfooding workflow at least twice in late April 2026 (after PR #13 stdin fix and PR #14 permission allowlist), each time costing minutes of confused debugging before "did I rebuild?" surfaced.

A local interim mitigation (option B from the backlog) is already in place: `.mcp.json` was rewritten to a bash wrapper that runs `npm run build --silent` before launching the node process. This eliminates the missed-build failure mode at the cost of ~3–5s per reconnect. The current `.mcp.json` is untracked because it's a per-developer hack and the canonical fix has not yet been chosen.

This sprint adopts **option C** as the canonical fix: switch development to `tsx` (direct TypeScript execution, no `dist/` step in the dev loop). Production/published artifacts continue to ship compiled JS via `tsc`; only the `.mcp.json` dev entry point changes.

The three options from the backlog were:

- **(A)** Background `npx tsc --watch` — smallest change, no per-reconnect overhead, but easy to forget the watcher and silently regress.
- **(B)** `.mcp.json` bash wrapper that runs `npm run build` before launching node — eliminates the missed-build failure mode at ~3–5s per reconnect. Adopted as interim local config 2026-04-28 (currently untracked in `.mcp.json`).
- **(C)** Switch to `tsx` for direct TS execution — eliminates the entire `dist/` dependency from the dev loop. Recommended for proper fix.

PO selection: **(C)**, with `.mcp.json` checked into the repo so every developer (and the bundled template) gets the benefit by default. The interim bash-wrapper `.mcp.json` is replaced, not preserved.

## Acceptance Criteria

- [ ] `tsx` is added as a `devDependency` in `package.json` (latest stable major)
- [ ] A new `npm` script `dev` (or equivalent) launches the MCP server directly from TypeScript via `tsx` without invoking `tsc` first — e.g. `tsx src/index.ts`
- [ ] `.mcp.json` at the repo root is checked into the repository (no longer untracked) and uses `tsx` to launch `src/index.ts` directly — no `npm run build` step, no `dist/` reference in the dev entry point
- [ ] Editing any file under `src/**/*.ts` and triggering `/mcp` reconnect picks up the change on the next tool call, with **no manual `npm run build` step required**
- [ ] `npm run build` (production `tsc` compile) continues to work and continues to produce `dist/` — the published `bin` entry (`dist/src/index.js` in `package.json`) is unchanged
- [ ] `npm test` continues to pass with the existing 435+ test count (no regressions in unit or integration suites)
- [ ] CI (or a `npm run`-able command) verifies that `tsx src/index.ts --version`-equivalent invocation succeeds — i.e. the server can boot under `tsx` without a `dist/` directory present. If no CI exists today, a check that's runnable as `npm run <script>` and invoked from the test suite is acceptable.
- [ ] The bundled project template (everything under `template/` plus the bootstrap scaffold definitions in `src/template.ts`) is updated so that **new projects created via `bootstrap_project` inherit the same `tsx`-based dev loop** if they are TypeScript projects. If the template doesn't currently emit a `.mcp.json` or `package.json`, this AC is satisfied by a no-op note in the architecture doc explaining why.
- [ ] CLAUDE.md's "Build & Test Commands" and "Running the MCP Server" sections are updated to reflect the new dev loop (e.g. `npm run dev` instead of `npm run build && node dist/src/index.js`)
- [ ] First-boot under `tsx` on a fresh checkout (clean `dist/`, fresh `node_modules` after `npm install`) succeeds end-to-end — i.e. `tsx`'s on-the-fly compile produces a working MCP server on the first `/mcp` reconnect

## Edge Cases

- **`tsx` not installed (`node_modules` missing)**: `.mcp.json` invocation should fail with a clear `npm install` hint, not a cryptic node error. If `tsx` is invoked through `npx tsx` rather than a direct binary path, `npx` already provides this; if a direct binary path is used, the architecture doc should address how to get a comparable error.
- **Production / published consumer**: A user who installs Raptor as an `npm` package (via the `bin: raptor` entry) must continue to get the **compiled JS** from `dist/`. `tsx` is dev-only; it must not become a runtime dependency for end users.
- **CI environment without `node_modules` cache**: First test run after a clean install should still pass. `tsx`'s compile cache should not be required — if it improves perf, fine, but tests must pass without it.
- **Stale `dist/` on disk**: With the dev loop now bypassing `dist/`, an old `dist/` may sit on disk indefinitely. This must not cause runtime confusion (the `.mcp.json` should never accidentally fall back to `dist/`).
- **Existing developer with the option-B bash wrapper `.mcp.json`**: When this PR lands, their local untracked `.mcp.json` will conflict with the now-tracked one. Demo / migration note should call this out so devs know to `git checkout .mcp.json` (or accept the new version) after pulling.
- **Windows / non-bash shells**: The interim option-B `.mcp.json` used a bash one-liner that wouldn't have worked on Windows. The new `tsx`-based `.mcp.json` should be shell-agnostic (e.g. `command: "npx"`, `args: ["tsx", "src/index.ts"]`) so cross-platform isn't regressed.
- **`/mcp` reconnect picks up changes that introduce a TypeScript compile error**: `tsx` should surface the compile error in the MCP server's stderr / Claude Code's MCP log, not silently keep running the previous version. This matches developer expectations and is strictly better than today's behavior of silently running stale `dist/`.

## Out of Scope

- Replacing `tsc` for production builds — `npm run build` and the published `dist/` artifact remain as today.
- Watch-mode for tests (`jest --watch`) — independent of this change.
- Hot-reload of an already-running MCP server without a `/mcp` reconnect — out of scope; the win here is "next reconnect picks up the edit," not "no reconnect at all."
- Migrating downstream Raptor-bootstrapped projects retroactively — only the Raptor repo itself and the template for *new* bootstraps are updated.
- Removing the `bin` entry or restructuring the published package layout.
- Deleting `.gitignore`'d artifacts (`dist/` stays gitignored as today).
- A live-claude smoke test (separate Sprint 9 backlog item `live-claude-smoke-test`).

## Open Questions

None — option C is selected by the PO. All implementation decisions (exact `tsx` version, exact `.mcp.json` shape, exact npm script name, whether to remove the option-B wrapper before or alongside introducing `tsx`) are deferred to the Architect.
