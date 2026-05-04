Feature: Dev Loop Rebuild Friction — Direct TypeScript Execution via tsx
  As a Raptor maintainer dogfooding the project
  I want changes to src/*.ts to take effect on the next /mcp reconnect without a manual `npm run build`
  So that I stop silently testing stale compiled JS after edits

  Background:
    Given the Raptor repository at the project root
    And the file `package.json` defines `dependencies` and `devDependencies`
    And the file `.mcp.json` defines the MCP server entry point used by Claude Code on `/mcp` reconnect

  # ─────────────────────────────────────────────────────────────────────
  # AC #1 — tsx is added as a devDependency
  # ─────────────────────────────────────────────────────────────────────

  Scenario: tsx is declared as a devDependency
    Given `package.json` is read
    Then `devDependencies.tsx` exists
    And the version range starts with "^4" (latest stable major at the time of writing)
    And `dependencies.tsx` does NOT exist
    And no other top-level package.json field references tsx

  Scenario: tsx is never declared as a runtime dependency for end users
    Given an end user installs Raptor via `npm install raptor`
    When npm reads `package.json#dependencies`
    Then tsx is not present in `dependencies`
    And tsx is not present in `peerDependencies`
    And tsx is not present in `optionalDependencies`

  # ─────────────────────────────────────────────────────────────────────
  # AC #2 — `dev` script launches tsx without invoking tsc first
  # ─────────────────────────────────────────────────────────────────────

  Scenario: The `dev` npm script launches the MCP server via tsx with no precompile
    Given `package.json` is read
    Then `scripts.dev` exists
    And `scripts.dev` invokes `tsx` against `src/index.ts`
    And `scripts.dev` does NOT invoke `tsc` or `npm run build`
    And `scripts.dev` does NOT reference `dist/`

  Scenario: The `dev:smoke` npm script verifies the server boots under tsx
    Given `package.json` is read
    Then `scripts["dev:smoke"]` exists
    And `scripts["dev:smoke"]` exits with code 0 when the server boots far enough to register MCP tools
    And `scripts["dev:smoke"]` exits non-zero if the server crashes before MCP-ready
    And `scripts["dev:smoke"]` works without a `dist/` directory present

  # ─────────────────────────────────────────────────────────────────────
  # AC #3 — `.mcp.json` is tracked and uses tsx (no dist/, no bash)
  # ─────────────────────────────────────────────────────────────────────

  Scenario: `.mcp.json` is tracked in git
    Given the repository's git index is queried
    Then `.mcp.json` is a tracked file (not in .gitignore, not untracked)

  Scenario: `.mcp.json` launches the dev server via npx tsx with no dist reference
    Given `.mcp.json` is parsed
    Then `mcpServers.raptor.command` equals "npx"
    And `mcpServers.raptor.args` is the array `["tsx", "src/index.ts"]`
    And no value anywhere in `.mcp.json` matches the regex /dist\b/
    And no value anywhere in `.mcp.json` matches the regex /\bnpm\s+run\s+build\b/
    And no value anywhere in `.mcp.json` matches /\b(bash|sh|zsh)\b/
    And no value anywhere in `.mcp.json` is an absolute path beginning with `/Users/` or `C:\\`

  Scenario: `.mcp.json` uses portable `cwd: "."` (no hard-coded developer path)
    Given `.mcp.json` is parsed
    Then if `mcpServers.raptor.cwd` is present, its value equals "."
    And the file content can be checked into git with no per-developer edits required

  # ─────────────────────────────────────────────────────────────────────
  # AC #4 — Edit-to-runtime: next /mcp reconnect picks up source edits
  # ─────────────────────────────────────────────────────────────────────

  Scenario: Editing src/*.ts is picked up on the next /mcp reconnect with no manual build
    Given the developer edits `src/index.ts` to add a stderr log line
    And the developer does NOT run `npm run build`
    When the developer triggers `/mcp` reconnect
    Then the MCP server respawns under `npx tsx src/index.ts`
    And the new stderr log line appears at boot
    And no `dist/src/index.js` was rebuilt during the reconnect

  Scenario: Stale `dist/` on disk is never preferred by the dev loop
    Given a stale compiled `dist/src/index.js` exists from a prior build
    And `src/index.ts` has been edited since `dist/` was produced
    When the developer triggers `/mcp` reconnect
    Then the running MCP server reflects the latest `src/index.ts` (tsx output)
    And `dist/src/index.js` is not loaded by node

  # ─────────────────────────────────────────────────────────────────────
  # AC #5 — Production build pipeline is unchanged
  # ─────────────────────────────────────────────────────────────────────

  Scenario: `npm run build` still produces dist/src/index.js via tsc
    Given `package.json` is read
    Then `scripts.build` equals "tsc" (or otherwise invokes tsc)
    When `npm run build` is executed in a clean checkout
    Then `dist/src/index.js` is produced
    And `package.json#bin.raptor` continues to point at `dist/src/index.js`

  Scenario: Published package layout is untouched
    Given `package.json` is read
    Then `main` continues to equal "dist/src/index.js"
    And `bin.raptor` continues to equal "dist/src/index.js"

  # ─────────────────────────────────────────────────────────────────────
  # AC #6 — Test suite still passes (435+ tests, no deletions)
  # ─────────────────────────────────────────────────────────────────────

  Scenario: `npm test` continues to pass with no regressions
    When `npm test` is executed
    Then the suite exits 0
    And the total test count is at least 435 (current baseline)
    And no existing unit or integration test was deleted to make the suite green

  # ─────────────────────────────────────────────────────────────────────
  # AC #7 — Boot-smoke is npm-runnable AND Jest-invokable
  # ─────────────────────────────────────────────────────────────────────

  Scenario: `npm run dev:smoke` succeeds without a `dist/` directory present
    Given `dist/` has been removed (`rm -rf dist`)
    And `node_modules/` is populated by `npm install`
    When `npm run dev:smoke` is executed
    Then the process exits successfully (clean exit or controlled stdin-close exit)
    And no uncaught exception was emitted to stderr
    And the smoke completes within the configured timeout

  Scenario: The integration suite invokes the boot smoke as a Jest test
    Given the integration test for dev-loop-rebuild-friction is present
    When `jest tests/integration/dev-loop-rebuild-friction` is executed
    Then the smoke spawn is wrapped in a child_process.spawn
    And the child process is killed with SIGTERM in `afterEach` to prevent orphaned `node` processes
    And the test asserts boot-success semantics consistent with `npm run dev:smoke`

  # ─────────────────────────────────────────────────────────────────────
  # AC #8 — Template handling (no-op for this sprint)
  # ─────────────────────────────────────────────────────────────────────

  Scenario: The bundled template still emits no .mcp.json or package.json (no-op satisfied)
    Given the bundled template directory `template/`
    Then `template/.mcp.json` does NOT exist
    And `template/package.json` does NOT exist
    And `src/template.ts#SCAFFOLD_DIRS` does NOT include any directory dedicated to a `.mcp.json` or `package.json`
    And the architecture document at `docs/architecture/dev-loop-rebuild-friction.md` contains a "Template handling" or "no-op" rationale paragraph

  # ─────────────────────────────────────────────────────────────────────
  # AC #9 — CLAUDE.md is updated to reflect the new dev loop
  # ─────────────────────────────────────────────────────────────────────

  Scenario: CLAUDE.md "Build & Test Commands" mentions the new `npm run dev` flow
    Given `CLAUDE.md` is read
    Then the "Build & Test Commands" section mentions "npm run dev"
    And the "Build & Test Commands" section still documents `npm run build` for production

  Scenario: CLAUDE.md "Running the MCP Server" no longer says `npm run build && node dist/src/index.js`
    Given `CLAUDE.md` is read
    Then the "Running the MCP Server" section references the new dev flow (tsx or `npm run dev`)
    And the section explains that `/mcp` reconnect now picks up `src/*.ts` edits without a manual build

  # ─────────────────────────────────────────────────────────────────────
  # AC #10 — First-boot from clean checkout (no dist/ required)
  # ─────────────────────────────────────────────────────────────────────

  Scenario: First-boot under tsx on a fresh checkout succeeds end-to-end
    Given a fresh checkout of the repository
    And `dist/` does not exist
    And `node_modules/` has just been populated by `npm install`
    When the developer triggers `/mcp` reconnect for the first time
    Then `npx tsx src/index.ts` produces a working MCP server
    And the server registers all 6 MCP tools (bootstrap_project, adopt_project, list_projects, get_project_status, run_sprint, resume_sprint)
    And no manual `npm run build` was required

  # ─────────────────────────────────────────────────────────────────────
  # Edge cases
  # ─────────────────────────────────────────────────────────────────────

  Scenario: tsx is not installed (node_modules missing) — clear failure, not cryptic
    Given `node_modules/` has been removed (or `tsx` is missing from it)
    When `/mcp` reconnect launches `npx tsx src/index.ts`
    Then `npx` surfaces a recognizable "tsx not found" error mentioning install
    And the error is NOT a bare `ENOENT` for a node binary
    And the developer can resolve it by running `npm install`

  Scenario: Production consumer (npm install raptor) still gets compiled JS from dist/
    Given a downstream user runs `npm install raptor`
    Then `tsx` is not installed as part of their runtime tree
    And the `bin.raptor` entry resolves to `dist/src/index.js`
    And invoking `raptor` runs the compiled JS, not TypeScript source

  Scenario: CI environment without node_modules cache still passes the test suite
    Given a clean CI runner with no node_modules cache
    When CI runs `npm install` followed by `npm test`
    Then the test suite passes
    And `tsx`'s compile cache is NOT required for tests to pass

  Scenario: Stale `dist/` on disk does not cause runtime confusion
    Given a stale `dist/` directory exists on disk (left over from a prior `npm run build`)
    When `/mcp` reconnect launches the dev entry point
    Then the dev entry point (`.mcp.json`) does not fall back to `dist/`
    And the running server reflects current `src/*.ts` only

  Scenario: Existing developer with the option-B bash-wrapper `.mcp.json` migrates cleanly
    Given a developer has the previous untracked option-B `.mcp.json` (bash wrapper running `npm run build`)
    When they pull the branch that lands this sprint
    Then git reports a conflict on `.mcp.json` (or refuses to overwrite the untracked file)
    And the documented migration path is `git checkout .mcp.json` to accept the new tracked version
    And after migration, `npm install` plus `/mcp` reconnect works without further manual steps

  Scenario: Cross-platform: `.mcp.json` is shell-agnostic (Windows / non-bash)
    Given a developer on Windows with no bash shell available
    Then `.mcp.json` is parsed and dispatched by the MCP client without invoking bash
    And `command: "npx"` plus `args: ["tsx", "src/index.ts"]` is the only invocation form
    And no `.mcp.json` value contains a bash one-liner or shell metacharacters

  Scenario: TypeScript compile error surfaces in stderr instead of silent stale execution
    Given `src/*.ts` is edited to introduce a TypeScript compile error
    When `/mcp` reconnect launches `npx tsx src/index.ts`
    Then tsx exits non-zero
    And the compile error is written to stderr
    And Claude Code's MCP log reports the server as failed
    And the previous (stale) `dist/src/index.js` is NOT silently used in place of the broken source
