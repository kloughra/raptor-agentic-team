---
slug: push-before-merge
artifact: po-test-review
status: approved
sprint: 15
reviewer: Petra (PO)
---

# PO Test Review — push-before-merge

**Decision: APPROVED. The BDD feature file and the integration suite are accepted as the acceptance gate for this feature. No blocking changes. Three non-blocking observations are recorded below; two are tracked forward to step 7 (PR review) / step 8 (acceptance). The Engineer may begin step 5 (Implement, TDD) immediately — the suite is RED against `main` for exactly the right reasons and turns GREEN only when C1–C4 are correctly implemented.**

## Scope of Review

- Spec: `docs/specs/push-before-merge.md` (AC 1–10, 7 edge cases, 3 Open Questions)
- Architecture: `docs/architecture/push-before-merge.md` (C1–C4; Open Question rulings 1–3 verified against test pins — see provenance below)
- BDD: `tests/bdd/push-before-merge.feature` (11 scenarios)
- Integration: `tests/integration/push-before-merge.integration.test.ts` (10 tests)
- **RED verification executed by PO on 2026-07-07** against current pre-change `main` (`merge.ts` does no pre-merge push): `npx jest tests/integration/push-before-merge` → **6 failed / 4 passed in 5.8s**. Every RED-tagged constraint-guard FAILS pre-change; every `[no-regression]` test PASSES. Details under "RED/GREEN audit" below.

## Headline

This suite continues the Sprint 13/14 standard and honors the follow-up mandate that spawned this feature. The constraint-guarding tests drive the **real** `executeMerge` and the **real** `runSprintFromStep` step-9 loop against **real** git repositories with **real** bare remotes over `simple-git` — the push under test is a genuine network write, not a reimplementation. Mocking is confined to exactly the two architecture-sanctioned boundaries: a **partial** `child_process` mock that intercepts `execFile` (the `gh` CLI only) while passing `spawn` through untouched, so `simple-git`'s real pushes/merges/clones run; and `spawnAgent` (runner-seam test only, to avoid spawning real `claude`). The top-of-file comment explicitly forbids widening these mocks to `spawn`/`simple-git` (TEAM.md QA rule 12, spec AC #9/#10). The Sprint 12 production specimen (demo/retro commits made locally, never pushed → stale remote → divergent merge) is directly replayed as `[RED:A]` and is RED today. This is what an acceptance gate for a root-cause fix should look like.

## Architect-ruling provenance check (pins are real, not invented)

Every value and behavior the tests pin traces to an explicit architecture ruling — all three spec Open Questions were resolved by the Architect and the tests encode those rulings:

| Test pin | Architecture source |
|---|---|
| Push runs at the head of the open-PR path only; every non-open-PR path is push-free | C1 (ruling (b): push lives in `mergeViaGitHub`), Constraint 1 |
| Push fails cleanly into retry; **no** fall-through to local merge on the GitHub path | C1 / **OQ1 ruling** (spec option a), Constraint 5 |
| `git.push(["origin", branchName])` — explicit remote + single refspec, upstream-agnostic | C1/C2 / **OQ2 ruling**; Constraints 3–4 |
| Only the feature branch is pushed; `main` can never be pushed by this call | C1 / **OQ3 ruling**, Constraint 3 |
| No `--force` / `--force-with-lease`; a genuine divergence fails the push, remote history untouched | AC #5, NFR 2, Constraint 2 |
| `gh pr merge` structurally unreachable after a failed push (assert never invoked) | C1/C3, Constraint 6, AC #2/#9 |
| Push failure returns `{success:false, method:"github", error}` and reuses the step-9 loop unchanged — no new escalation path | C4 / AC #3 |
| Push-failure `error` is prefixed to name it a push failure + names the branch | C1 / NFR 6 / AC #8 |
| No schema change; `MergeResult` shape unchanged | Data Model |

## Acceptance Criteria → Test Coverage

| AC | BDD | Integration | RED pre-change? | Verdict |
|----|-----|-------------|-----------------|---------|
| 1 — push precedes GitHub merge | ✅ | ✅ `[RED:A]` local-only c2 lands on remote before merge; merge invoked exactly once; method "github" | ✕ RED | Accept |
| 2 — push failure fails cleanly, never merges | ✅ | ✅ `[RED:B]` success:false, `gh pr merge` never invoked; + explicit never-throws test | ✕ RED | Accept |
| 3 — feeds existing retry/escalation loop | ✅ | ✅ `[RED:S]` real runner seam: attempts==MAX_RETRY_ATTEMPTS, one failure record each, escalated, `[ESCALATE]` commit, steps 10–13 stay pending, `spawnAgent` never called | ✕ RED | Accept |
| 4 — no-remote / local fallback unchanged | ✅ | ✅ `[no-regression]` method "local", no push, remote ref absent | ✓ passes both | Accept |
| 5 — safe push only, no force | ✅ | ✅ `[RED:C]` remote-ahead divergence → push rejected, merge never invoked, remote still at collaborator's c2 | ✕ RED | Accept |
| 6 — already-merged short-circuits, no push | ✅ | ✅ `[no-regression]` alreadyMerged:true, no push, no merge | ✓ passes both | Accept |
| 7 — PR-closed-without-merge unchanged, no push | ✅ | ✅ `[no-regression]` existing failure, "closed" in error, no push | ✓ passes both | Accept |
| 8 — actionable error (push ≠ merge failure) | ✅ | ✅ `[RED:B]` error lowercases to contain "push" and contains the branch name | ✕ RED | Accept |
| 9 — production seam | ✅ (header contract) | ✅ verified structurally (real `executeMerge` + real runner step-9 loop, real bare remotes, sanctioned mocks only) **and** empirically (RED run below) | ✕ RED (guards) | Accept |
| 10 — push uses simple-git | ✅ (single refspec `origin <branch>`) | ✅ enforced by design: `execFile`(gh) mocked, `spawn`(simple-git) real; a raw-`git` execFile push would hit the mock's "unexpected execFile call" guard | n/a (structural) | Accept — see Observation 1 |

### Edge cases

| Edge case | Coverage |
|---|---|
| Local branch already in sync → no-op push, merges normally | ✅ `[no-regression]` already-in-sync (remote head unchanged, merge once) |
| Remote ahead of local (genuine divergence) → push fails, no force, escalates | ✅ `[RED:C]` |
| No-remote / local fallback (`gh` unavailable) → no push | ✅ `[no-regression]` AC #4 |
| Push succeeds but `gh pr merge` fails (branch protection) | ➖ Not separately pinned — merge-failure handling is Out of Scope (delivered by Sprint 13, unchanged here); the push fix does not touch it. Acceptable. |
| `--delete-branch` ordering (push → merge+delete, no dangling failure) | ➖ Structural (C3): `gh` is mocked, so the real delete isn't exercised; ordering is guaranteed by the push strictly preceding the merge in the same promise chain. Acceptable. |
| First push of a branch with no configured upstream | ✅ **partially** — `[RED:A]` seeds the remote ref via a bare `git.push` (no `-u`), so `executeMerge`'s push operates on a branch with **no tracking config**, exercising the upstream-agnostic form (OQ2). The true "remote ref does not yet exist" success case is not directly pinned — see Observation 2. |

### Test categories (TEAM.md QA rule)

Consistent with every prior orchestrator-internal feature in this repo, and **explicitly recorded, not silently skipped**, in the BDD header:
- **Playwright E2E — Not Applicable.** No UI surface (headless MCP orchestrator). Recorded.
- **Performance — Not Applicable.** Architecture NFR 3 introduces no numeric latency threshold and no new timeout surface (one `git push` before each open-PR merge). Recorded.
- **QA rule 13 (default-off parity test) — Not Applicable.** This feature has **no optional config gate**; the push is unconditional on the open-PR path (architecture NFR 5: "No new config surface"). The test file states this correctly; the closest analog — proving the unchanged non-open-PR paths stay push-free — is the three `[no-regression]` tests (AC #4/#6/#7). Accepted.

BDD + integration are the applicable categories. Accepted.

## RED/GREEN audit (PO-executed, 2026-07-07)

Result: **6 ✕ / 4 ✓** against pre-change `main`. The split maps exactly to the file's self-documentation — every `[RED:*]` guard fails, every `[no-regression]` passes:

RED (constraint-guards, fail pre-change):
- ✕ `[RED:A]` push precedes merge (AC #1)
- ✕ `[RED:B]` success:false / merge never invoked (AC #2, #9)
- ✕ `[RED:B]` error names push failure + branch (AC #8)
- ✕ never-throws-on-push-failure (AC #2) — *fails pre-change because it also asserts `success:false`; see Observation 3*
- ✕ `[RED:C]` no-force divergence (AC #5)
- ✕ `[RED:S]` runner-seam escalation accounting (AC #3)

GREEN (`[no-regression]`, pass before AND after):
- ✓ already-in-sync no-op push
- ✓ local fallback, no push (AC #4)
- ✓ already-merged short-circuit (AC #6)
- ✓ PR-closed-without-merge (AC #7)

The RED-verification notes in the file's header ([A]/[B]/[C]/[S], "revert C1 and the four go GREEN→RED") are empirically confirmed. TEAM.md QA rule 12 is satisfied.

## Observations (non-blocking)

1. **AC #10 is enforced structurally, not by a dedicated named assertion.** The partial-mock design (real `simple-git` `spawn`, mocked `gh` `execFile`) guarantees the push goes through `simple-git`, and the BDD scenario pins the single-refspec `origin <branch>` form. There is no explicit integration assertion that `main`'s remote ref is never written (the OQ3 "feature-branch-only" guarantee is proven by the invocation form, not by an after-state check on `origin/main`). This is adequate for approval — the single positional refspec structurally cannot push `main`. *Optional strengthening (QA's discretion, may land with the impl PR): add one assertion in the `[RED:A]` test that `refSha(remote, "main")` is unchanged after the push.* Not required.

2. **The true "first push, remote ref absent" success path is not directly pinned.** Per architecture C2, `mergeViaGitHub` only runs when an open PR (hence a remote branch counterpart) already exists, so this case is unreachable on the production seam — the architect's rationale is sound and I accept the omission. The upstream-agnostic form (OQ2) *is* exercised (Observation under Edge Cases). No change required.

3. **Trivial labeling nuance on the never-throws test.** `does not throw even when the push fails (AC #2 — never-throws contract)` is untagged yet is RED, because its `toMatchObject({ success: false })` couples it to the new behavior (pre-change returns `success: true` without throwing). Its RED status therefore proves "fails cleanly," not strictly "never throws" (which holds on both sides). This is correct coverage of AC #2's combined requirement; if QA wants the audit header perfectly literal, tag it `[RED]` or split the throw-assertion from the success-shape assertion. Comment-only, zero logic change, may land with the impl PR.

## Out-of-Scope items correctly excluded

- No changes asserted to the step-9 retry/escalation control flow itself — it is **reused** (the `[RED:S]` seam test drives the real Sprint-13 loop). ✅
- No changes to squash strategy, `MAX_RETRY_ATTEMPTS`, or the gh-vs-simple-git selection logic. ✅
- No failure-signature short-circuit for push rejections (`merge-failure-short-circuit` / `user-actionable-failure-class` tracked separately) — the push simply fails cleanly into the existing loop. ✅
- No auto-resolution of divergence (rebase/force) — `[RED:C]` proves the orchestrator never force-updates the remote. ✅
- No schema change / no state migration. ✅

## Decision

**Approved.** The BDD feature file is approved as-is. The integration suite is approved as the acceptance gate; the three non-blocking Observations above are recorded (Observations 1 and 3 are optional comment/assertion touch-ups QA may bundle into the implementation PR). Engineer may begin step 5 (Implement, TDD) immediately: the suite is RED against `main` for exactly the right reasons (6/6 constraint-guards fail; 4/4 no-regression tests pass) and will turn GREEN only when C1–C4 are correctly implemented — a pre-merge `simple-git` push of the single feature-branch refspec at the head of `mergeViaGitHub`, non-forced, failing cleanly into the existing retry loop with a push-named error.
