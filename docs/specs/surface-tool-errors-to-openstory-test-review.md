---
slug: surface-tool-errors-to-openstory
artifact: po-test-review
status: changes-requested
sprint: 16
reviewer: Petra (PO)
---

# PO Test Review — surface-tool-errors-to-openstory

**Decision: CHANGES REQUESTED — one required addition (R1). The BDD feature file and the integration suite are otherwise excellent: comprehensive AC coverage, honest RED-verification notes, real tool functions run against real tmp dirs / registry / git, and the classification policy (`surfaceOutcome`) is the real production code under test. The single gap that blocks approval is AC #10's core requirement — "drive the *real* surfacing seam ... the actual tool registration/wrapping path in `src/index.ts`." The suite transcribes that wrapper (`runThroughSeam`) rather than exercising the real `index.ts` registration, so a tool handler left unwired in `index.ts` would ship the exact bug this feature exists to fix, with a fully-green suite. Close R1 and I approve. I also record my PO sign-off on Decision D4 (below) and non-blocking observations O1–O3.**

## Scope of Review

- Spec: `docs/specs/surface-tool-errors-to-openstory.md` (AC 1–10, 6 edge cases, 5 Open Questions)
- Architecture: `docs/architecture/surface-tool-errors-to-openstory.md` (D1–D4)
- BDD: `tests/bdd/surface-tool-errors-to-openstory.feature` (13 scenarios / outlines)
- Integration: `tests/integration/surface-tool-errors-to-openstory.integration.test.ts`
- **RED verification executed by PO on 2026-07-12** against current pre-change `main`: `ls src/error-surfacing.ts` → absent; `npx jest tests/integration/surface-tool-errors-to-openstory` → **suite fails to run: TS2307 cannot find module `../../src/error-surfacing`** (the `[IMPORT-RED]` the file documents). Suite is genuinely RED pre-change.
- **Factual claims cross-checked against source:** `src/tools.ts` carries **19** `status: "error"` literal returns (lines 210/218/232/242/315/329/338/345/354/365/537/542/550/665/672/686/692/732/739) — the conformance test's `>= 15` threshold is satisfied and robust. `src/index.ts` content assembly for the four JSON tools and for `run_sprint`/`resume_sprint` was compared line-by-line to the test's `buildJsonContent` / `buildSprintContent` — the transcription is **faithful to today's `index.ts`**.

## Headline

This suite continues the Sprint 13/14/15 standard. The failure-classification policy (`isFailureStatus`, `FAILURE_STATUSES`, `surfaceOutcome`, `buildThrownErrorResult`) is real production code exercised directly — not a fake — and the tools run for real (real tmp home, real `Registry` JSON, real `simple-git` repo for the thrown path). RED-verification notes are specific and correct. Every one of AC 1–10 has a corresponding, well-aimed assertion. The one thing missing is the part that matters most for *this* feature: proof that `src/index.ts` actually routes **all six** registered handlers through the seam.

## Recorded decision — PO sign-off on D4 (escalated)

Spec OQ #4 and architecture **D4** explicitly require **PO sign-off on the observable intent** for how `escalated` is treated at the boundary. **I sign off: `escalated` is attention-needed, NOT a boundary failure, by default.** Rationale: an `escalated` sprint is a truthful, healthy circuit-breaker handoff to the user (Sprint 13 truthful-completion contract), not a swallowed error; flagging it as a boundary failure would over-trigger a detector on healthy escalations. This is a **recorded product decision**, not an accidental mapping. If a stakeholder later wants escalations detectable at the boundary, the change is the one-line addition of `"escalated"` to `FAILURE_STATUSES` — to be raised as a new backlog item, not a silent flip. The test that pins `escalated` → no `isError` correctly encodes this decision.

## Acceptance Criteria → Test Coverage

| AC | BDD | Integration | RED pre-change? | Verdict |
|----|-----|-------------|-----------------|---------|
| 1 — failures machine-detectable at boundary | ✅ | ✅ every failure family → `isError:true` | ✕ RED | Accept (policy); see R1 for seam |
| 2 — structured, classifiable signal (not prose) | ✅ | ✅ `isError` flag + structured body + `isFailureStatus(status)`; thrown path carries `tool` | ✕ RED | Accept |
| 3 — all `{status:"error"}` returns covered | ✅ | ✅ conformance walks real `tools.ts`, every literal ∈ FAILURE_STATUSES | ✕ RED | Accept (tools.ts side); see R1 for index.ts side |
| 4 — thrown exceptions surfaced consistently | ✅ | ✅ thrown → `isError:true` + `{status,tool,message}`; thrown vs returned indistinguishable | ✕ RED | Accept |
| 5 — success byte-for-byte unchanged, NO `isError` key | ✅ | ✅ `"isError" in surfaced === false` + `content` deep-equals today's `JSON.stringify` | ✕ RED (PARITY-RED) | Accept |
| 6 — no failure swallowed into success | ✅ | ✅ families + conformance | ✕ RED | Accept (subject to R1) |
| 7 — trust substrate for notification-egress | ➖ property | ➖ guaranteed by AC 1–6, not separately testable | n/a | Accept |
| 8 — lifecycle fidelity (failed=fail; complete/paused/in-progress/escalated≠fail) | ✅ | ✅ `failed`→isError; `complete`/`paused`/`in-progress`→no key; `escalated`→no key | ✕/✓ mixed | Accept |
| 9 — no PII/secret widening | ✅ | ✅ thrown path emits `message` only; asserts stack + secret path absent from serialized result | ✕ RED | Accept |
| 10 — production-seam + conformance + parity + lifecycle | ✅ (header contract) | ⚠️ conformance ✅, parity ✅, lifecycle ✅ — but the **real `index.ts` registration/wrapping path is transcribed, not exercised** | partial | **R1 — required** |

### Edge cases

| Edge case | Coverage |
|---|---|
| Failure path that already throws (unguarded `git.init()`/`fs`) | ✅ thrown-exception tests; thrown vs returned proven indistinguishable |
| `run_sprint` `paused` / `complete` must not read as failure | ✅ lifecycle outline |
| `run_sprint` `escalated` — recorded decision, not accident | ✅ pinned (no `isError`) + PO sign-off above |
| Message contains word "error" but status is success | ✅ `{status:"success", message:"completed with no error"}` → no `isError` |
| `adopt_project` partial success (tolerated best-effort sub-failure) | ✅ BDD scenario; mechanism can't misclassify a `success` return — acceptable (O2) |
| Existing consumers parsing `{status,message}` JSON | ✅ success-parity deep-equality proves the body is untouched |

### Test categories (TEAM.md QA rule)

- **Playwright E2E — Not Applicable.** Headless MCP orchestrator, no UI surface. Recorded.
- **Performance — Not Applicable.** Architecture NFR introduces no numeric latency threshold — classification is a single `Set` lookup per call. Recorded, consistent with every prior orchestrator-internal feature. Accepted.
- **QA rule 13 (default/success parity) — Satisfied by analog.** This feature has no optional config gate (surfacing is unconditional at the boundary); the rule-13 analog is the success-parity test proving a *successful* `CallToolResult` is byte-for-byte identical to today's wrapping (no `isError` key). Present and correct.

BDD + integration are the applicable categories.

## Required change (blocking)

**R1 — Exercise the real `src/index.ts` registration path, not a transcription (AC #10, TEAM.md QA rule 12).**
The integration suite routes real tool returns through `runThroughSeam`, a hand-copied replica of the `index.ts` handler wrapper. Two problems:
1. **Drift.** It is a copy. If `index.ts`'s real wiring later diverges from the replica, the suite stays green while production breaks. The architecture's own OR-clause requires the exported helpers be "invoked **EXACTLY** as the seam invokes them" — a replica that can drift does not guarantee "exactly."
2. **Coverage hole — the highest-value one.** Nothing asserts that **all six** `index.ts` handlers are actually wrapped. AC #10(b)'s conformance guard walks `tools.ts` (the *return* side); no test walks the *wrapping* side. If the Engineer wires 5 of 6 tools through `surfaceOutcome` and forgets one, every test here is green and we ship the exact swallow-into-success bug — for that tool — that OpenStory can't see. That is the precise failure this feature exists to eliminate.

**What's required:** a guard that a forgotten/unwired handler in `index.ts` fails the suite — i.e. coverage tied to the real registration, so all six tools are proven to route through the seam (failure → `isError`, success → no `isError`).

**Mechanism is the Architect's call, not mine** (I'm only asserting the coverage requirement against AC #10). One low-cost, feasible path to note: the test header's premise that "`index.ts`'s `main()` cannot be invoked without a live transport" is only true of the *stdio wiring* — the *tool registration* can be extracted into a `registerTools(server, ctx)` and driven for real either via the SDK's in-memory linked transport pair (a real client→server tool round-trip, no stdio) or by capturing and invoking the registered callbacks. That would make these same assertions run against the genuine `index.ts` seam and would subsume `runThroughSeam`. Please coordinate with the Architect (Anky) on the lightest option; if `registerTools` extraction is chosen it is an additive refactor with no behavior change.

## Observations (non-blocking)

- **O1 — Colocated unit file.** The architecture lists `src/error-surfacing.test.ts`; it isn't among the authored artifacts (the module doesn't exist yet). The pure functions (`isFailureStatus`, `FAILURE_STATUSES`, `buildThrownErrorResult`) are already exercised directly inside the integration file, so AC coverage does not depend on it. Adding the colocated unit file with the implementation PR is welcome but optional.
- **O2 — `adopt_project` partial-success** is covered in BDD but not as a dedicated integration test. Acceptable: the seam classifies solely from the tool's actual `status` return, so a `success` return with a tolerated sub-failure structurally cannot be misclassified. No change required.
- **O3 — Conformance test scope.** The `tools.ts` walk keys on `status: "error"` literals only; the failure status `"failed"` is produced dynamically by the orchestrator (`run_sprint` returns `result.status`), never as a literal in `tools.ts`, and is covered by the explicit `FAILURE_STATUSES` set test + the `failed`→`isError` lifecycle test. Coverage is complete; noting the split so a future reader doesn't expect `"failed"` in the literal walk.

## Out-of-Scope items correctly excluded

- No `notification-egress` / notification behavior built — this feature only makes failures first-class (AC #7). ✅
- No change to `tools.ts` implementations or the `{status, message}` body shape — surfacing is additive at the boundary. ✅
- No redefinition of orchestrator lifecycle statuses or the Sprint 13 truthful-completion contract. ✅
- `sprint-result-status-hardcoded-escalated` left as a separate tracked item. ✅
- No new dependency, no persisted state, no config surface. ✅

## Decision

**Changes requested — R1 only.** The BDD feature file is approved as-is. The integration suite is approved on every dimension except AC #10's real-seam requirement: it must guard the actual `src/index.ts` registration so an unwired handler fails the suite (drift-proof, all-six-tools coverage). D4 (`escalated` ≠ boundary failure) has my PO sign-off and is a recorded product decision. Observations O1–O3 are non-blocking. On R1's resolution I will approve and the Engineer may proceed to step 5 (Implement, TDD); the suite is already RED against `main` for the right reason (the seam module does not yet exist) and will turn GREEN only when `error-surfacing.ts` implements the D1–D4 contract and `index.ts` routes all six tools through it.
