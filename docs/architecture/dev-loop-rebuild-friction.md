---
slug: dev-loop-rebuild-friction
spec: docs/specs/dev-loop-rebuild-friction.md
---

# Dev Loop Rebuild Friction — Architecture Design

## Overview

This change replaces the Raptor inner dev loop's `tsc → dist/ → node` chain with a single direct-from-TypeScript invocation via [`tsx`](https://github.com/privatenumber/tsx). The development entry point in `.mcp.json` will boot `src/index.ts` directly; on every `/mcp` reconnect, `tsx` performs an on-the-fly compile from current source. There is no `dist/` dependency in the dev loop, so an edit cannot be silently shadowed by a stale build.

Production semantics are unchanged: `npm run build` still produces `dist/src/index.js`, `package.json#bin` still points there, and end users who `npm install raptor` continue to receive compiled JS. `tsx` is introduced strictly as a `devDependency` and only the dev entry point references it.

The interim option-B `.mcp.json` (bash wrapper that runs `npm run build` before launching node) is **replaced**, not preserved — the tracked `.mcp.json` becomes the single source of truth.

The change surface is small and almost entirely declarative: one new devDependency, one new npm script, one file checked in (`.mcp.json`), one boot-smoke npm script, and a CLAUDE.md doc update. There is no production code change.

## Components

| Component | File(s) | Change |
|-----------|---------|--------|
| Dev entry point | `.mcp.json` | Switch from bash-wrapper to `npx tsx src/index.ts`; check the file in (currently untracked) |
| Package metadata | `package.json` | Add `tsx` to `devDependencies`; add `dev` and `dev:smoke` scripts |
| Production entry | `package.json#bin`, `dist/src/index.js` | **Unchanged** — production still ships compiled JS |
| Production build | `npm run build`, `tsc`, `tsconfig.json` | **Unchanged** |
| Boot smoke check | new npm script `dev:smoke` | New: invoke `tsx src/index.ts` in a way that asserts boot success without a `dist/` directory present |
| Boot smoke test wiring | `tests/integration/dev-loop-rebuild-friction.integration.test.ts` (QA owns) | QA invokes `dev:smoke` from a Jest test as the AC's "runnable from the test suite" hook |
| Bundled template | `template/`, `src/template.ts` | **No-op for this sprint** — template currently does not emit `.mcp.json` or `package.json` (see Constraints) |
| Developer documentation | `CLAUDE.md` | Update "Build & Test Commands" and "Running the MCP Server" sections to reference `npm run dev` |
| Test suite | All existing tests | **Must remain green** — 435+ tests, no regressions |

The Engineer's actual code-touching surface is `package.json`, `.mcp.json`, `CLAUDE.md`, and one boot-smoke test file (QA-authored). No `src/**/*.ts` files are modified.

## Data Model

No data model changes. No state schema changes. No on-disk format changes.

## API Contracts

No MCP tool contract changes. The 6 MCP tools (`bootstrap_project`, `adopt_project`, `list_projects`, `get_project_status`, `run_sprint`, `resume_sprint`) keep their schemas, return shapes, and behavior.

The only "contract" affected is the **dev entry point** in `.mcp.json`, which is consumed by Claude Code's MCP client on `/mcp` reconnect:

**Before (current untracked `.mcp.json`):**
```json
{
  "mcpServers": {
    "raptor": {
      "command": "bash",
      "args": [
        "-c",
        "cd /Users/kloughra/workspace/raptor-agentic-team && npm run build --silent && exec node dist/src/index.js"
      ]
    }
  }
}
```

**After (tracked `.mcp.json`):**
```json
{
  "mcpServers": {
    "raptor": {
      "command": "npx",
      "args": ["tsx", "src/index.ts"],
      "cwd": "."
    }
  }
}
```

Notes on the shape:

- `command: "npx"` + `args: ["tsx", ...]` is shell-agnostic (no bash one-liner) and cross-platform compatible. This addresses the Windows / non-bash-shell edge case.
- `npx tsx` (vs. a direct binary path like `./node_modules/.bin/tsx`) gives us the "missing dependency → clear `npm install` hint" behavior for free: `npx` prints a recognizable error if the package isn't available locally rather than producing a cryptic `ENOENT`.
- `cwd: "."` is relative to the `.mcp.json` location (Claude Code's MCP loader resolves it against the project root). This avoids hard-coding `/Users/kloughra/...` so the file is portable across developer machines — a key reason it can be checked in.
- No `dist/` reference anywhere. A stale `dist/` on disk cannot be picked up.

## Non-Functional Requirements

| NFR | Target | Rationale / Measurement |
|-----|--------|------------------------|
| **Dev-loop edit-to-runtime latency** | Edit → next `/mcp` reconnect picks up the change. **No manual build step.** | Primary user-visible win. Verified by AC #4 and the boot-smoke check. |
| **Reconnect cold-start time** | < 5 seconds wall clock to MCP-ready | `tsx` JIT-compiles on boot. Should be comparable to or faster than today's `npm run build && node` (~3–5s). Not measured by an automated perf test in this sprint — qualitative gate during demo. |
| **Test suite runtime** | No regression (current ~435 tests should run within current envelope) | `tsx` is not invoked by the test runner; Jest + ts-jest path is unchanged. |
| **Test count** | ≥ 435 (current baseline). No deletions. | AC explicit. |
| **Production runtime overhead from `tsx`** | Zero | `tsx` is `devDependencies` only. Verified by inspecting `dependencies` in `package.json` after the change. |
| **Cross-platform compatibility** | macOS, Linux, Windows | `.mcp.json` uses `npx` (no bash). Edge case explicitly addressed. |
| **First-boot from clean checkout** | `npm install && /mcp reconnect` works without a manual build | AC #10. `tsx` does on-the-fly compile; no `dist/` required. |
| **Compile-error visibility** | TypeScript compile errors must surface in stderr / Claude Code MCP log; the server must NOT silently keep running a previous version | `tsx` exits non-zero on compile failure → Claude Code reports the MCP server as failed → developer sees the error rather than running stale code. Strictly better than today's silent-stale behavior. Verified qualitatively during demo. |
| **No new runtime dependencies for end users** | `dependencies` in `package.json` unchanged | Inspected at PR review. |

## Technology Choices

### REQUIRES USER APPROVAL

Per Architect responsibilities, any new dependency must be presented to the user. This sprint introduces one:

**`tsx` (https://github.com/privatenumber/tsx)** — devDependency, latest stable major (currently `4.x`).

- **Purpose:** Direct execution of TypeScript source files without a precompile step. Built on top of esbuild for fast JIT compilation.
- **Why it (vs. alternatives):**
  - **vs. `ts-node`:** `tsx` is significantly faster (esbuild vs. typescript compiler), simpler config (zero config in our case), and is the modern community default for "just run a TS file." We already use `ts-jest` for tests so we're not adopting `ts-node`-style transformer infrastructure.
  - **vs. `bun`:** Would require a new runtime install. Out of scope.
  - **vs. `node --loader ts-node/esm` or `node --experimental-strip-types`:** Both have rough edges for stdio-MCP-server use cases (loader API is unstable; native strip-types is too new and doesn't handle all syntax). `tsx` is battle-tested.
  - **vs. options A/B:** Decided by PO in the spec. (A) is footgun-prone; (B) is the current interim and has bash-only, slow-reconnect drawbacks.
- **Footprint:** dev-only; not shipped to npm consumers.
- **Maintenance:** Active project, MIT-licensed, no funding/governance concerns.
- **Version pinning:** `^4.x` (caret on the latest major at the time of install). No specific patch pin required.

**ADR:** This decision will be recorded as `docs/adr/ADR-002-tsx-dev-loop.md` (next ADR number — ADR-001 is `technology-stack.md`). The Engineer creates the ADR file as part of the implementation; this architecture doc is the design rationale, the ADR is the canonical decision record.

### Already-approved (no change)

| Tool | Role | Status |
|------|------|--------|
| TypeScript / `tsc` | Production build | Unchanged |
| `@modelcontextprotocol/sdk` | MCP transport | Unchanged |
| `simple-git` | Git operations | Unchanged |
| `jest` + `ts-jest` | Test runner | Unchanged |
| `npm` | Package manager | Unchanged |
| Node.js | Runtime | Unchanged |

## Constraints & Patterns

### Constraints

1. **No production code change.** Nothing under `src/**/*.ts` is modified. The dev loop is a build/orchestration concern only.
2. **`dist/` stays gitignored.** Existing `.gitignore` for `dist/` is unchanged. Stale `dist/` on a developer machine is harmless because the dev loop no longer reads it.
3. **`bin` entry untouched.** `package.json#bin.raptor` continues to point at `dist/src/index.js`. End-user installs are unaffected.
4. **`.mcp.json` becomes tracked.** Add it to git. Remove any local-only behavior. Path-portability: use `cwd: "."` rather than absolute paths.
5. **`tsx` is dev-only.** Goes in `devDependencies`, never `dependencies`.
6. **Cross-platform.** No bash one-liners in `.mcp.json`. Use `command: "npx"` + array args.
7. **Migration friction is acceptable but documented.** Existing developers with the option-B `.mcp.json` will get a git conflict on pull. The demo / sprint summary must call out the `git checkout .mcp.json` (or accept-incoming) action so devs aren't surprised.
8. **Boot-smoke check is `npm run`-able and Jest-invokable.** AC requires the check to be runnable as both an npm script and from the test suite. The npm script is the authoritative form; the integration test simply shells out to `npm run dev:smoke` (or invokes `tsx` directly with the same args) and asserts non-zero exit.

### Patterns

#### Boot-smoke check pattern

The AC says: *"a check that's runnable as `npm run <script>` and invoked from the test suite is acceptable."* The implementation pattern:

1. **`npm run dev:smoke`** — Invokes `tsx src/index.ts` with a stdin that closes immediately and asserts the process boots far enough to register MCP tools without throwing. The MCP server registers tools synchronously during `main()` before awaiting transport, so a clean exit (or controlled stdin-close exit) within a short timeout indicates a successful boot. **Critical:** the smoke must be runnable without a `dist/` directory present — Engineer should verify by `rm -rf dist/` before invoking during the demo. Implementation detail (Engineer's choice): a small helper script under `scripts/` or an inline node `-e` is acceptable; Architect prefers a tiny `scripts/dev-smoke.ts` that spawns `tsx src/index.ts`, sends `EOF` on stdin, captures stderr, and exits non-zero if the process crashes before MCP-ready.
2. **Integration test** (QA's deliverable, `tests/integration/dev-loop-rebuild-friction.integration.test.ts`): wraps `dev:smoke` invocation, asserts exit code 0 and absence of unexpected stderr. **Important:** this test must clean up child processes on Jest timeout (`afterEach` kill) to avoid orphaned `node` processes during CI. Standard `child_process.spawn` with `kill('SIGTERM')` in `afterEach` is sufficient.

#### `.mcp.json` shape pattern

Always: `command: "npx"`, `args: ["tsx", "src/index.ts"]`. Do not introduce shell wrappers. If future scenarios need pre-launch steps, prefer adding them as npm scripts and pointing `.mcp.json` at the script via `args: ["tsx", "scripts/launch.ts"]` — keep `.mcp.json` declarative.

#### Template handling (no-op rationale)

Per spec edge case + AC #8: *"If the template doesn't currently emit a `.mcp.json` or `package.json`, this AC is satisfied by a no-op note in the architecture doc explaining why."*

Inspection (`ls template/` and `src/template.ts:SCAFFOLD_DIRS`) confirms:
- `template/` contains only `TEAM.md`.
- `SCAFFOLD_DIRS` creates empty docs/tests/src directories.
- `generateReadme()` emits a minimal README; `generateBacklog()` emits an empty backlog.
- **Neither `bootstrap_project` nor `adopt_project` writes a `package.json` or `.mcp.json` for new projects today.**

Therefore: there is nothing in the template to update for `tsx`. New Raptor-bootstrapped projects choose their own runtime/language and bring their own `package.json`. **AC #8 is satisfied by this paragraph.** Future work to scaffold a default `package.json` + `.mcp.json` for TypeScript-flavored bootstraps would be a separate backlog item (likely under `bootstrap-typescript-template` or similar).

#### CLAUDE.md update pattern

Two sections need editing:

1. **"Build & Test Commands"** (around line 49): Keep `npm run build` (production), but add `npm run dev` (dev loop entry) at the top.
2. **"Running the MCP Server"** (around line 94): Replace `npm run build && node dist/src/index.js` with `npm run dev` (or, more accurately, mention that `/mcp` reconnect triggers `npx tsx src/index.ts` automatically via the tracked `.mcp.json`).

#### Migration note pattern (for demo / sprint summary)

Add to the sprint summary's "Migration" section:
> Pull this branch → if you have a local untracked `.mcp.json`, run `git checkout .mcp.json` to accept the new tracked version. Then `npm install` (to pick up `tsx`), then `/mcp` reconnect. No `dist/` rebuild required.

### Out of Scope (re-stated for engineer guidance)

- Replacing `tsc` for production. **Don't touch `npm run build` semantics.**
- Watch-mode tests. **Don't touch jest config.**
- Hot-reload without `/mcp` reconnect. **Not a goal.**
- Scaffolding `package.json` / `.mcp.json` into bootstrapped projects. **No-op per template-handling pattern above.**
- Removing or restructuring `bin`. **Untouched.**
- Live-claude smoke test. **Separate backlog item.**

### Order of operations for the Engineer

1. Branch is already `sprint-9/dev-loop-rebuild-friction`. ✓
2. `npm install --save-dev tsx` (installs latest stable major).
3. Add `dev` and `dev:smoke` npm scripts to `package.json`.
4. Write `scripts/dev-smoke.ts` (or equivalent) implementing the boot-smoke check.
5. Replace `.mcp.json` content with the `npx tsx`-based shape and `git add .mcp.json` (it is currently untracked).
6. Update CLAUDE.md sections.
7. Hand off to QA — QA writes the integration test that wraps `dev:smoke` plus any BDD scenarios (`tests/bdd/dev-loop-rebuild-friction.feature`).
8. Engineer implements until tests pass; commit with `[ENGINEER]` prefix.
9. PR; Architect + QA review (parallel); demo includes "edit a `console.error` in `src/index.ts`, `/mcp` reconnect, see the new log line — no manual build."

### Risk register

| Risk | Severity | Mitigation |
|------|----------|------------|
| `tsx` produces subtly different runtime behavior from `tsc + node` (e.g. import resolution edge case) | Medium | Smoke check covers boot. Existing 435 tests run under `ts-jest` — same TS-execution model family. If a divergence appears, fall back is trivial: revert `.mcp.json`. |
| `npx tsx` slow on first invocation if package not cached | Low | Mitigated by being a `devDependency` — `npm install` puts it in `node_modules` and `npx` finds it locally without network. |
| Developer pulls branch and forgets to `npm install` | Low | `npx` will print a clear "could not find tsx" error rather than running stale code. Better than the silent-stale failure mode being fixed. |
| Windows developer hits a `.mcp.json` shape issue we didn't anticipate | Low | Standard `npx` invocation pattern is well-supported by Claude Code's MCP client across platforms. No bash. |
| Existing untracked `.mcp.json` causes git conflict on pull | Low / known | Documented in migration note. |

## Codebase Context

### Files touched by this sprint

- `package.json` — add `tsx` devDependency, `dev` and `dev:smoke` scripts
- `.mcp.json` — replace content, add to git
- `CLAUDE.md` — two doc sections updated
- `scripts/dev-smoke.ts` (new) — boot-smoke implementation (Engineer's exact choice of file path/extension)
- `tests/bdd/dev-loop-rebuild-friction.feature` (new, QA) — BDD scenarios
- `tests/integration/dev-loop-rebuild-friction.integration.test.ts` (new, QA) — wraps `dev:smoke`
- `docs/adr/ADR-002-tsx-dev-loop.md` (new, Engineer or Architect) — records the `tsx` decision
- `docs/architecture/dev-loop-rebuild-friction.md` (this file) — Architect deliverable

### Files NOT touched (explicit non-goals)

- Anything under `src/**/*.ts` (no production code change)
- `tsconfig.json` (production build path unchanged)
- `jest.config.js` (test runner unchanged)
- `template/TEAM.md` and `src/template.ts` (per template no-op rationale)
- `package.json#bin`, `package.json#main`, `package.json#dependencies` (production surface unchanged)
- `.gitignore` (`dist/` stays ignored)
