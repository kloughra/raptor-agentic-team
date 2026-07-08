---
slug: blocker-marker-false-positive-in-agent-output
artifact: po-test-review
status: approved
sprint: 15
reviewer: Petra (PO)
---

# PO Test Review — blocker-marker-false-positive-in-agent-output

**Decision: APPROVED. All four QA test surfaces (BDD, integration, colocated unit, performance) accurately reflect the acceptance criteria, honor the Architect's Open-Question rulings, and follow TEAM.md QA rule 12 (production-seam parity at BOTH runner seams, with RED-verification notes). No changes requested. Engineer may begin TDD implementation.**

## Scope of Review

- Spec: `docs/specs/blocker-marker-false-positive-in-agent-output.md` (AC 1–9, Edge Cases, Out of Scope)
- Architecture: `docs/architecture/blocker-marker-false-positive-in-agent-output.md` (OQ1–OQ3 rulings + two-seam correction verified below)
- BDD: `tests/bdd/blocker-marker-false-positive-in-agent-output.feature` (24 scenarios/examples)
- Integration: `tests/integration/blocker-marker-false-positive-in-agent-output.integration.test.ts`
- Unit (colocated): `src/orchestrator/blocker-marker.test.ts`
- Performance: `tests/performance/blocker-marker-false-positive-in-agent-output.perf.test.ts`

## Headline

This is a clean, well-scoped suite that gates a detection-only hardening without touching frozen escalation mechanics. Three things stand out:

1. **Both production seams are exercised through the real runner.** The Architect's provenance table corrected the spec's Codebase Context — there are **two** seams (single-feature `runner.ts:1196` and multi-feature `runner.ts:1951`), not one. The integration suite drives the real `runSprintFromStep` at both, mocking only `spawnAgent` (the sanctioned mock, explicitly annotated "do NOT widen"). This satisfies QA rule 12's demand for parity asserted at each seam, not merely on the pure function.
2. **RED-verification is honest and specific.** Every constraint-guarding test carries a `RED:` note explaining exactly how it fails against the pre-change `/\[blocker\]/i` anywhere-match; non-constraint tests are tagged `[no-regression]`. The suite is doubly RED on `main` (the module doesn't exist yet AND the behavior differs), which is the correct starting state.
3. **The live incident is replayed.** The Sprint 12 fenced decision-pipeline specimen (`b4c5ffb`) is reproduced at both the unit level and the real single-/multi-feature runner seams → asserts no `[ESCALATE]` commit. This is the exact regression the feature exists to prevent.

## Architect-ruling provenance check (rulings are honored, not silently dropped)

| Architect ruling | Test consequence | Verdict |
|---|---|---|
| **OQ1 — fix git-parser this sprint** (line-anchor + `stripSuppressedLines`) | git-parser tests assert fenced/blockquoted-body markers → 0 entries, and the orchestrator's own `[ESCALATE] … agent raised [BLOCKER]: …` commit → 1 escalation / 0 blockers | Honored |
| **OQ2 — 4-space indent is NOT code; do not suppress** | Unit tests assert space- and tab-indented (non-fenced) markers ARE genuine (`true`); no test suppresses indentation | Honored |
| **OQ3 — keep reading raw agent stdout** (reject commit-only) | Detection tests run against agent output strings / the real runner stdout path; no test moves the read site to committed messages | Honored |
| **Two seams, one function** | Integration exercises single- AND multi-feature seams through the same detector | Honored |
| **Conservative bias on ambiguity** (unclosed fence → suppress) | Unit + BDD assert unclosed fence and mismatched-inner-delimiter → `false` | Honored |

## Acceptance Criteria → Test Coverage

| AC | BDD | Unit | Integration | Perf | Verdict |
|----|-----|------|-------------|------|---------|
| 1 — line-anchored only (mid-prose ≠ blocker) | ✅ | ✅ RED | ✅ RED | — | Accept |
| 2 — fenced (```` ``` ```` and `~~~`) suppressed | ✅ | ✅ RED (incl. tilde + mismatched delimiter) | ✅ RED | — | Accept |
| 3 — blockquote suppressed | ✅ | ✅ RED (incl. leading-ws before `>`) | ✅ RED | — | Accept |
| 4 — genuine blocker still escalates | ✅ | ➖ (seam concern) | ✅ real runner, both seams: `[ESCALATE]`+`[BLOCKER]`, escalated status, early return | — | Accept |
| 5 — case-insensitivity | ✅ outline | ✅ (incl. `bLoCkEr`) | ✅ | — | Accept |
| 6 — git-parser hardened (per OQ1) | ✅ | ➖ | ✅ fenced/quoted body → 0; `[ESCALATE]`-embeds-`[BLOCKER]` → 1 esc/0 blk; genuine still parsed | — | Accept |
| 7 — escalation semantics / schema frozen | ✅ | ➖ | ✅ (frozen `[ESCALATE]` format + early-return asserted via genuine-blocker cases; state loads unchanged) | — | Accept |
| 8 — regression reproduces live incident | ✅ | ✅ RED (Sprint 12 specimen) | ✅ RED (Sprint 12 specimen at seam) | — | Accept |
| 9 — production-seam coverage | ✅ | ➖ | ✅ real `runSprintFromStep`, single + multi, quoted → no escalate / genuine → escalate | — | Accept |
| Edge: mid-line prose | ✅ | ✅ | ✅ | — | Accept |
| Edge: leading whitespace/tab is genuine | ✅ | ✅ | — | — | Accept |
| Edge: 4-space indent NOT suppressed (OQ2) | ➖ | ✅ (indented marker → genuine) | — | — | Accept |
| Edge: unclosed fence → suppress remainder | ✅ | ✅ RED | — | — | Accept |
| Edge: multiple markers, ≥1 genuine → escalate | ✅ | ✅ | — | — | Accept |
| Edge: trailing text after marker → genuine | ✅ | ✅ | — | — | Accept |
| Edge: empty / marker-free → not a blocker | ✅ | ✅ | — | — | Accept |
| Edge: CRLF vs LF parity | ✅ outline | ✅ | — | — | Accept |
| NFR: never throws on untrusted input | ✅ | ✅ | — | — | Accept |
| NFR: bounded linear-time on ~1 MB | ✅ | — | — | ✅ (marker-free, fenced, early-return, `stripSuppressedLines`) | Accept |

Every AC (1–9), every Edge Case, and both NFRs (reliability, performance) have executable coverage. No orphaned AC.

## Notes (non-blocking, for the record)

- **No Playwright E2E — correctly omitted.** TEAM.md requires E2E for UI features; this is a non-UI backend detection change with no UI seam. Both the unit and integration headers document this exclusion with reasoning. Accepted.
- **QA rule 13 (default-off parity test) does not apply.** That rule targets features gated behind optional config whose contract is "absent config = prior behavior." This feature is an unconditional behavioral hardening, not config-gated, so a default-off parity test is not owed. QA correctly did not force one.
- **AC 7 schema-freeze is asserted structurally, not by golden-byte diff.** The genuine-blocker seam tests assert the frozen `[ESCALATE]` format elements, the early-return (demo/team step never runs), and that persisted state loads/round-trips unchanged. A literal byte-for-byte snapshot of "today's" commit isn't practically testable and isn't required — the frozen-format assertions are sufficient to catch a mechanics regression.
- **`stripSuppressedLines` is tested as a first-class exported primitive** (both unit and integration), matching the architecture's "single suppression implementation" pattern shared by runner and git-parser. Good — this pins the reuse contract, not just the top-level behavior.

## Out-of-Scope Items Correctly Excluded

- No change to escalation mechanics / `[ESCALATE]` commit format / retry pipeline / circuit-breaker thresholds — tests only assert these remain unchanged. ✅
- No `SprintState` schema change or state migration. ✅
- No stricter structured (JSON) blocker format — marker convention unchanged; only detection hardened. ✅
- No NLP/intent detection beyond structural line-anchor + fence/quote rules. ✅
- `parseBlockers`/`parseEscalations` return shapes and grammars untouched — only match anchoring / excluded body text change (per OQ1). ✅

## Decision

**Approved.** BDD, integration, unit, and performance suites all accurately encode AC 1–9, the edge cases, and the NFRs; they honor the Architect's OQ1–OQ3 rulings and the two-seam correction; and they are RED against current `main` for the right reasons. Handing off to the Engineer for TDD implementation (create `src/orchestrator/blocker-marker.ts`, rewire both runner seams, harden `git-parser.ts`).
