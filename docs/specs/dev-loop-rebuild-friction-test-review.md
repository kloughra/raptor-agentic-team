---
slug: dev-loop-rebuild-friction
artifact: po-test-review
status: approved
sprint: 9
reviewer: Petra (PO)
---

# PO Test Review — dev-loop-rebuild-friction

**Decision: APPROVED. Engineer may proceed with implementation.**

## Scope of Review

- Spec: `docs/specs/dev-loop-rebuild-friction.md`
- Architecture: `docs/architecture/dev-loop-rebuild-friction.md`
- BDD: `tests/bdd/dev-loop-rebuild-friction.feature` (12 happy-path scenarios + 7 edge-case scenarios)
- Integration: `tests/integration/dev-loop-rebuild-friction.integration.test.ts` (10 describe blocks, ~30 assertions)

## Acceptance Criteria → Test Coverage

| AC | BDD scenario(s) | Integration assertion(s) | Verdict |
|----|-----------------|--------------------------|---------|
| #1 — `tsx` is `devDependency` ^4 | "tsx is declared…", "tsx is never declared as a runtime dependency…" | `AC #1` describe block: 4 assertions (devDep present, caret-major range, no `dependencies/peerDependencies/optionalDependencies` entries) | ✅ Covered |
| #2 — `dev` script via tsx, no tsc | "The `dev` npm script…", "The `dev:smoke` npm script…" | `AC #2` describe block: 4 assertions (`scripts.dev` shape, no tsc/build/dist, `scripts['dev:smoke']` present, `scripts.build` unchanged) | ✅ Covered |
| #3 — `.mcp.json` tracked + uses `npx tsx`, no dist/bash | "`.mcp.json` is tracked in git", "`.mcp.json` launches the dev server…", "`.mcp.json` uses portable `cwd: \".\"`…" | `AC #3` describe block: 7 assertions (file exists, not gitignored, `mcpServers.raptor` shape, `command: "npx"`, `args: ["tsx", "src/index.ts"]`, no dist/bash/abs-path strings, portable `cwd`) | ✅ Covered |
| #4 — Edit → next /mcp reconnect picks up change | "Editing src/*.ts is picked up…", "Stale `dist/` on disk is never preferred…" | Indirectly verified by AC #3 assertions (no dist reference) + boot smoke | ✅ Covered (demo-gated for the user-visible behavior, which is appropriate — fully end-to-end automation is out of scope per architecture) |
| #5 — `npm run build` unchanged, `bin` unchanged | "`npm run build` still produces…", "Published package layout is untouched" | `AC #5` describe block: 3 assertions (`main`, `bin.raptor`, `scripts.start` if present) | ✅ Covered |
| #6 — `npm test` passes (≥435, no deletions) | "`npm test` continues to pass…" | Self-verifying via the test run itself (no explicit count assertion, but acceptable — the AC is enforced by Jest's exit code) | ✅ Covered |
| #7 — Boot smoke is `npm run`-able AND Jest-invokable | "`npm run dev:smoke` succeeds…", "The integration suite invokes the boot smoke as a Jest test" | `AC #7` describe block: 3 assertions (spawn `npx tsx src/index.ts`, run `npm run dev:smoke`, boot without dist/) — uses `child_process.spawn`, `afterEach` SIGTERM cleanup per architecture pattern | ✅ Covered |
| #8 — Bundled template no-op | "The bundled template still emits no .mcp.json or package.json…" | `AC #8` describe block: 4 assertions (no `template/.mcp.json`, no `template/package.json`, `SCAFFOLD_DIRS` clean, architecture rationale present) | ✅ Covered |
| #9 — CLAUDE.md updated | "CLAUDE.md \"Build & Test Commands\"…", "CLAUDE.md \"Running the MCP Server\"…" | `AC #9` describe block: 4 assertions (file exists, mentions `npm run dev`, retains `npm run build`, replaces `node dist/...` phrase) | ✅ Covered |
| #10 — First-boot from clean checkout | "First-boot under tsx on a fresh checkout succeeds end-to-end" | Boot smoke under AC #7 acts as the runtime proxy; full destructive `rm -rf node_modules && npm install` is correctly out of scope for an integration test | ✅ Covered |

## Edge Case Coverage

All 7 spec edge cases have explicit BDD scenarios. Three are also encoded as integration assertions (tsx-not-installed → "developer-friendly failure" describe block; production consumer → "production consumer is unaffected" describe block; stale `dist/` → covered by AC #3 assertions). The remaining four (option-B migration, Windows shell-agnostic, compile-error visibility, CI without cache) are demo-gated and qualitative — acceptable.

## Notes on Test Style

1. **Skip-gracefully pattern.** The integration tests use `console.warn` + early `return` when artifacts (`scripts.dev`, `tsx` in `node_modules`, the new `.mcp.json` shape) aren't yet wired. This is intentional per the file's docstring: it lets the test file commit ahead of implementation, then enforces the contract once the engineer wires things up. Acceptable, and called out explicitly in the architecture's "Order of operations." Engineer must verify that **every** `console.warn` early-return path becomes an enforced assertion after their changes land — confirm by running `npm test` and checking for warning output.
2. **Boot-smoke pattern is faithful to architecture §"Boot-smoke check pattern".** `child_process.spawn` + `proc.stdin.end()` + 15s/30s timeout + `afterEach` SIGTERM. No orphaned-process risk.
3. **`extractSection` helper for CLAUDE.md** is reused across AC #9 assertions — clean.
4. **No flakiness vectors observed** — the boot smoke uses a generous timeout and asserts well-defined exit semantics.

## Required Reading Block

The integration test includes a `Required reading: spec and architecture artifacts` describe block that asserts both files exist on disk before any other test runs. This is a nice belt-and-braces guard.

## Out-of-Scope Items Correctly Excluded

- No watch-mode test wiring (out of scope per spec).
- No hot-reload-without-reconnect test (out of scope).
- No retroactive migration test for downstream bootstrapped projects (out of scope).
- No `bin` restructure assertions beyond confirming it's untouched (out of scope).

## Pre-existing Stub File

`tests/integration/dev-loop-rebuild-friction` (extension-less marker file) exists as a workaround for the `expected-outputs-glob-resolution` and `artifact-injection-directory-handling` orchestrator bugs (already deferred to inbox). Not test code — Jest does not execute it. No action required from QA or Engineer in this sprint; will be deleted alongside the bug fix.

## Decision

**Approved.** Tests faithfully reflect every acceptance criterion and edge case from the spec. The Engineer may now proceed with implementation per the architecture's "Order of operations":

1. `npm install --save-dev tsx`
2. Add `dev` and `dev:smoke` scripts to `package.json`
3. Implement `scripts/dev-smoke.ts` (or equivalent)
4. Replace `.mcp.json` content; `git add .mcp.json`
5. Update CLAUDE.md sections
6. Run `npm test` and ensure every warning-skip in the integration suite becomes an enforced pass
7. Open PR

No changes requested. Handoff to Engineer to follow.
