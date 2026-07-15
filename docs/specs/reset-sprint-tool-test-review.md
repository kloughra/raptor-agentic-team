---
slug: reset-sprint-tool
artifact: po-test-review
status: approved
sprint: 16
reviewer: Petra (PO)
---

# PO Test Review — reset-sprint-tool

**Decision: APPROVED. The BDD feature file and the integration suite are accepted as the acceptance gate for this feature. No blocking changes. Four non-blocking observations are recorded below. The Engineer may begin step 5 (Implement, TDD) immediately — the suite is RED against the current `sprint-16` base for exactly the right reasons (the whole tool is net-new) and will turn GREEN only when `resetSprintTool` + `deleteSprintState` are correctly implemented per the architecture.**

## Scope of Review

- Spec: `docs/specs/reset-sprint-tool.md` (AC 1–12, 7 edge cases, 5 Open Questions)
- Architecture: `docs/architecture/reset-sprint-tool.md` (OQ1–5 all resolved; NFR-1–8; control-flow steps 1–6)
- BDD: `tests/bdd/reset-sprint-tool.feature` (14 scenarios incl. one Scenario Outline over 4 statuses)
- Integration: `tests/integration/reset-sprint-tool.integration.test.ts` (21 tests across 10 describe blocks + the `deleteSprintState` helper block)
- **RED verification executed by PO on 2026-07-12** against the current pre-change `sprint-16` base (`resetSprintTool` and `deleteSprintState` do not exist): `npx jest tests/integration/reset-sprint-tool` → **21 failed / 21 total in 0.7s**. Every test is RED because the tool and the state helper are net-new — there is no prior behavior to regress against, so all-RED is the correct and expected signal here.

## Headline

This suite holds the Sprint 13/14/15 production-seam standard. It drives the **real** `resetSprintTool` through a **real** `ToolContext` (real `Registry` backed by a temp `projects.json`, a real project dir on disk) against a **real** temp `~/.raptor` state file written by the **real** `saveSprintState`. The only redirection is `os.homedir()` via the jest os-shim so state lands under a temp dir — the filesystem layer is **not** mocked on the happy paths (AC 12). The single mock (`fs.rmSync` throwing) is confined to the AC-10 error path, and the file comment correctly justifies it as provoking the error branch, not neutering the real delete. The primary target — the un-resumable `in-progress` limbo (`runner.ts:1818`) that `resume_sprint` refuses — is explicitly pinned and RED today because no built-in clear path exists.

## Architect-ruling provenance check (pins are real, not invented)

Every value the tests pin traces to an explicit, resolved Open Question or NFR in the architecture — I verified each against `docs/architecture/reset-sprint-tool.md`:

| Test pin | Architecture source |
|---|---|
| Reset **deletes** the file (`fs.existsSync(...)===false` after reset); `deleteSprintState` uses `fs.rmSync` | **OQ1 → Delete** (§Overview / §Data Model / Constraint "Delete, don't rewrite"). This makes the file-non-existence assertion and the `fs.rmSync` error-mock legitimate, not an over-constraint. |
| Optional boolean `confirm`; guards **only** `complete`; escalated/failed/in-progress/paused reset freely | **OQ2 → boolean `confirm`, complete-only** (§API Contracts / control-flow step 4) |
| Response carries `priorStatus` + a one-line summary; no full progress dump | **OQ3** (§Data Model) |
| No log line / audit file written | **OQ4 → fire-and-forget** (§Constraints) |
| No concurrency lock / live-run detection | **OQ5 → no lock** (NFR-8) |
| New `deleteSprintState(slug, sprint): boolean` in `state.ts`, returns true/removed·false/absent, idempotent | §Components / §Data Model code block |
| No-op success `priorStatus:"none"`, message "nothing to reset / no sprint state" | control-flow step 3 / §API Contracts no-op example |
| Complete-guard error message contains "complete" + "confirm" | §API Contracts complete-guard example |
| FS-failure message contains "Failed to clear" / "EACCES" / "permission denied" | control-flow step 5 / §API Contracts error example |
| `nextAction: "run_sprint {slug} {N}"`; no `checkpoint` payload (no resume-style re-attempt) | control-flow step 6 / NFR-6 / AC 11 |
| Only the target `sprint-{N}.json` removed; sibling sprint, registry, backlog, summaries intact | NFR-4 / AC 8 |

## Acceptance Criteria → Test Coverage

| AC | BDD | Integration | RED pre-change? | Verdict |
|----|-----|-------------|-----------------|---------|
| 1 — first-class tool, `{status,...}`, never throws | ✅ (Background) | ✅ `resetSprintTool` is a function; every path returns a structured object; AC-3 "never throws" test | ✕ RED | Accept — see Obs 1 (index.ts registration verified at step 7, not integration) |
| 2 — inputs name/sprint/confirm (Zod) | ✅ (Background) | ✅ exercised via args on every call; `confirm` behavior pinned by AC-7 tests | n/a (Zod lives in index.ts) | Accept — see Obs 2 |
| 3 — project-resolution parity, returned-not-thrown | ✅ | ✅ unknown-project error, missing-dir error, explicit `.resolves.toBeDefined()` never-throws | ✕ RED | Accept |
| 4 — clean slate (file gone → step 1) | ✅ | ✅ file absent + `loadSprintState()===null` after reset | ✕ RED | Accept |
| 5 — rescues escalated/failed/in-progress/paused | ✅ (Scenario Outline ×4) | ✅ parametrized loop over all four + dedicated in-progress-limbo test | ✕ RED | Accept |
| 6 — no-state no-op success + idempotency | ✅ (×3) | ✅ no-file→`priorStatus:"none"`; twice-safe; sprint 999 no-op | ✕ RED | Accept |
| 7 — complete guard (refuse w/o confirm, clear with) | ✅ (×3) | ✅ refuse leaves file intact + msg contains complete/confirm; `confirm:true` clears; escalated needs no confirm | ✕ RED | Accept |
| 8 — scope boundary: state file only | ✅ | ✅ target gone; sibling sprint, backlog, summary, registry bytes all unchanged | ✕ RED | Accept |
| 9 — response names outcome + next action | ✅ | ✅ project, sprint, priorStatus, message, `nextAction` contains run_sprint+slug+N | ✕ RED | Accept — see Obs 3 (`summary`/OQ3 field not separately asserted) |
| 10 — real FS failure → error, not false success | ✅ | ✅ `fs.rmSync` mocked to throw → `{status:"error"}`, msg names reason, file still present | ✕ RED | Accept |
| 11 — distinct from resume: no feedback/re-attempt/auto-run | ✅ | ✅ `checkpoint` undefined, `nextAction` run_sprint, file not re-seeded | ✕ RED | Accept |
| 12 — production seam + RED notes | ✅ (header contract) | ✅ real tool + real ctx + real temp state; per-test RED notes; verified empirically (21/21 RED) | ✕ RED | Accept |
| — `deleteSprintState` helper (§Components) | ➖ | ✅ exported, returns true/removed·false/absent, idempotent | ✕ RED | Accept |

### Edge cases

| Edge case | Coverage |
|---|---|
| Sprint stuck `in-progress` (primary target) | ✅ Scenario Outline row + dedicated "frees the in-progress limbo resume_sprint refuses" test |
| No `sprint-N.json` present | ✅ no-op success `priorStatus:"none"` |
| `complete` / merged sprint | ✅ refused w/o confirm (file intact), cleared with confirm |
| Multi-feature sprint state (whole file) | ➖ Not separately pinned. Acceptable: reset operates on the whole `sprint-N.json` unconditionally (single `deleteSprintState` call), so single- vs multi-feature is indistinguishable to the tool — no branch to guard. |
| Registered project, missing disk dir | ✅ error parity test |
| Reset while actively running | ➖ Out of scope by spec/architecture (OQ5 no-lock, user responsibility); documented in the tool description. Correctly not tested. |
| Invalid sprint number (0/negative/non-existent) | ✅ sprint 999 → no-op success. (Zod `positive()` rejects 0/negative at the index.ts layer — see Obs 2.) |

### Test categories (TEAM.md QA rule) — recorded

- **Playwright E2E — Not Applicable.** No UI surface (headless MCP orchestrator).
- **Performance — Not Applicable as a dedicated suite.** NFR-1 (<10 ms) is an O(1) `existsSync` + `readFileSync` + `rmSync` with no subprocess/git/network and no new timeout surface; there is no numeric threshold worth a perf test. Recorded (see Obs 4 — the BDD header does not explicitly stamp these N/A the way `push-before-merge` did).
- **QA rule 13 (default-off parity test) — Not Applicable.** This feature introduces no optional-config-gated behavior; `confirm` is an operation input, not an inert-by-default capability. No byte-identical-when-unset contract to pin.

BDD + integration are the applicable categories. Accepted.

## RED audit (PO-executed, 2026-07-12)

`npx jest tests/integration/reset-sprint-tool` → **21 ✕ / 21 total** against the pre-change base. Failures are `resetSprintTool is not a function` (TypeError from the untyped `require`) and `deleteSprintState is undefined` — i.e. the tool and helper genuinely do not exist yet. Every constraint-guarding scenario, including the `in-progress` crux (un-resumable at `runner.ts:1818`), is RED for the right reason. There are no no-regression tests here by design: the tool is net-new, so there is no existing behavior to hold green. TEAM.md QA rule 12 is satisfied.

## Observations (non-blocking)

1. **AC 1 "seven tools" / `index.ts` registration is not asserted at the integration layer.** The integration suite validates the `resetSprintTool` function contract directly; it does not boot the MCP server to assert the seventh `server.tool(...)` registration or the `content[]` mapping. This is the standard layering in this repo (the existing six tools are the same) and is verified at step 7 (Architect/QA review) and the demo. No change required; carried forward to step 7.

2. **AC 2 Zod validation lives in `index.ts`, so it is not directly exercised.** Per the architecture, `confirm` is `z.boolean().optional().default(false)` and `sprint` is `z.number().int().positive()` at the registration boundary; `resetSprintTool` receives already-parsed args. The tests correctly drive the tool function with concrete args (including `confirm`), and `confirm` semantics are fully pinned by the AC-7 tests. The `positive()` rejection of `0`/negative sprint numbers is a registration-layer concern, consistent with `run_sprint`/`resume_sprint`. Acceptable; no change required.

3. **The OQ3 `summary` field (discarded-state one-liner) is not separately asserted.** AC 9's hard requirements — project, sprint, prior status, and the `run_sprint` next action — are all pinned. The architecture additionally returns a `summary` ("N/M steps complete, status '…'") for post-mortem readability; no test checks it. This is an auditability nicety beyond AC 9, not a gap in the acceptance gate. *Optional (QA discretion, may land with the impl PR): one assertion that a successful clear returns a non-empty `summary` string.* Not required.

4. **The BDD header does not explicitly stamp Playwright/Performance as N/A.** `push-before-merge` recorded these in a "Test categories" note; this feature's `.feature` file omits it. Purely a documentation-consistency nit — I have recorded the N/A rationale in this review (see above), which satisfies the "record, don't silently skip" intent. *Optional: add the two-line N/A note to the BDD header.* Not required.

## Out-of-Scope items correctly excluded

- **No shared/forked control flow with `resumeSprint`** — reset imports and calls neither `resumeSprint` nor `runSprintFromStep` (NFR-6); the AC-11 test asserts no `checkpoint` re-attempt payload and no re-seeded state. ✅
- **No directional feedback carried into a re-attempt** — reset is feedback-free (AC 11). ✅
- **No auto-run after reset** — tool clears and stops; `nextAction` instructs the caller to invoke `run_sprint`. ✅
- **No touching of durable artifacts** — git branches/PRs, specs/architecture/tests/code, `docs/sprints/` summaries, `docs/backlog.md`, and `~/.raptor/projects.json` are all left intact (AC-8 test pins backlog/summary/registry bytes). ✅
- **No per-feature/per-step partial reset** — whole-file clear only (`orchestrator-recovery-after-mixed-completion` territory). ✅
- **No new config surface, no schema change, no state migration** (NFR-5). ✅
- **No concurrency lock** (OQ5 / NFR-8) — documented as user responsibility. ✅

## Decision

**Approved.** The BDD feature file is approved as-is. The integration suite is approved as the acceptance gate; the four non-blocking Observations are recorded (Obs 3 and Obs 4 are optional touch-ups QA may bundle into the implementation PR). Engineer may begin step 5 (Implement, TDD) immediately: the suite is RED (21/21) against the current base for exactly the right reason — `resetSprintTool` and `deleteSprintState` are net-new — and will turn GREEN only when the tool is implemented per the architecture: project-resolution parity → prior-status read via `loadSprintState` → complete-only `confirm` guard → `fs.rmSync` delete via the new `deleteSprintState` helper → truthful `{status,...}` result naming the prior status and the `run_sprint` next action, never throwing to the transport.
