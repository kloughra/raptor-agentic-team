---
slug: blocker-marker-false-positive-in-agent-output
status: ready
sprint: 15
---
# Blocker-Marker False Positive in Agent Output

## User Story
As a **sprint operator** running Raptor, I want a `[BLOCKER]` marker to trigger
an escalation **only when the agent is actually raising a blocker** — not when
the agent merely *quotes, documents, or discusses* the marker string — so that a
step which legitimately produced correct work (a demo presentation, a spec, a
decision-pipeline diagram) is not falsely escalated to me, forcing a needless
redo or manual state edit.

## Background
`hasBlockerMarker` (`src/orchestrator/runner.ts:301-303`) currently tests
`/\[blocker\]/i` against the **entire** agent output string. Any occurrence of
the literal marker anywhere in the output — inside a fenced code block, a quoted
example, or prose describing the marker convention — is treated as a real
blocker and drives an immediate `[ESCALATE]` commit + early return
(`runner.ts:1194-1225`).

**Confirmed live incident:** Sprint 12 step 8 (Demo) escalated (commit
`b4c5ffb`) because the demo presentation quoted the decision-pipeline diagram
containing the literal marker. It was confirmed a false positive at demo review;
the demo content stood and no redo was required — but the false escalation cost
operator time and required manual triage.

The backlog item also directs us to inspect `[ESCALATE]` detection in
`src/git-parser.ts` for the same quoting weakness while we are in the area
(`parseBlockers` line 26, `parseEscalations` line 47 both `.match` the marker
anywhere in a commit message).

## Acceptance Criteria

1. **Line-anchored marker detection.** `hasBlockerMarker` treats output as a
   real blocker **only** when a `[BLOCKER]` marker appears at the **start of a
   line** (ignoring leading whitespace), not when it appears mid-sentence or
   embedded in prose.

2. **Fenced code blocks are ignored.** A `[BLOCKER]` marker that appears inside
   a fenced code block (```` ``` ````-delimited, and `~~~`-delimited) does NOT
   trigger a blocker, even if it is at the start of a line within the fence.

3. **Quoted / indented-as-example text is ignored.** A `[BLOCKER]` marker that
   appears inside a Markdown blockquote (line beginning with `>`) does NOT
   trigger a blocker.

4. **Genuine blockers still escalate.** An agent that raises a real blocker by
   emitting `[BLOCKER]` at the start of a line in ordinary output STILL triggers
   the existing escalation path (`[ESCALATE]` commit + early return) with no
   behavioral change to the escalation mechanics themselves.

5. **Case-insensitivity preserved.** Detection remains case-insensitive
   (`[BLOCKER]`, `[blocker]`, `[Blocker]` all match when otherwise qualifying),
   matching today's `/i` behavior.

6. **`git-parser.ts` quoting weakness assessed and, if present, fixed.**
   `parseBlockers` and `parseEscalations` are reviewed for the same
   anywhere-in-string weakness. Because these parse **commit messages** (git
   log), the marker is expected at the start of a commit message / line; the
   parsers must not match a marker that appears only in quoted or fenced body
   text of a commit message. If the Architect determines the commit-message
   surface is not exposed to the same false-positive risk, that determination is
   recorded (Open Question 1) rather than silently skipped.

7. **No change to escalation semantics or state schema.** The retry/circuit-
   breaker pipeline, the `[ESCALATE]` commit format, the early-return contract,
   and the `SprintState` schema are unchanged. This feature only changes *what
   counts as* a blocker marker, not what happens once one is detected.

8. **Regression coverage reproduces the live incident.** Tests include a
   scenario modeled on the Sprint 12 false positive: output containing the
   marker only inside a fenced diagram / quoted block asserts
   `hasBlockerMarker` returns `false`; a companion scenario with a
   line-anchored marker asserts `true`. Each constraint-guarding test carries a
   RED-verification note per TEAM.md QA rule 12 (proven to FAIL against the
   pre-change anywhere-match implementation).

9. **Production-seam coverage.** At least one test drives the real runner path
   (not only the `hasBlockerMarker` pure function) proving that a demo-style
   output quoting the marker does NOT produce an `[ESCALATE]` escalation, and
   that a genuine line-anchored blocker DOES.

## Edge Cases
- Marker mid-line in prose: `"...if the agent writes [BLOCKER] then it escalates..."` → NOT a blocker.
- Marker at line start with leading whitespace/indentation (` `, `\t`) but NOT inside a fence or blockquote → IS a blocker (leading whitespace tolerated).
- Marker inside an indented (4-space) code block → treated as code; decision on 4-space indent handling deferred to Architect (Open Question 2) — at minimum fenced blocks (AC 2) must be excluded.
- Nested / unclosed fences: an opened ```` ``` ```` fence with no closing fence — the remainder of the output is treated as inside the fence (conservative: suppress false positives) unless Architect rules otherwise.
- Multiple markers in one output where some are quoted and one is a genuine line-anchored raise → escalates (at least one genuine marker present).
- Marker with surrounding text on the same line after it, e.g. `[BLOCKER] QA: cannot find spec` at line start → IS a blocker (this is the genuine-raise shape).
- Empty output / no marker → NOT a blocker (unchanged).
- CRLF vs LF line endings → line-anchoring works for both.

## Out of Scope
- Changing the escalation mechanics, `[ESCALATE]` commit format, retry pipeline, or circuit-breaker thresholds.
- Any change to `SprintState` schema or persisted state files (no migration).
- Requiring agents to emit blockers in a stricter structured format (e.g. JSON) — the marker convention stays as-is; only detection is hardened.
- Broader NLP/intent detection of "is this really a blocker" beyond structural (line-anchor + fence/quote stripping) rules.
- Reworking `parseBlockers`/`parseEscalations` return shapes or the `[BLOCKER] Role: desc -- blocked on Role` grammar (git-parser changes, if any, are limited to where a match is anchored/what body text is excluded).

## Open Questions
1. **git-parser exposure (AC 6).** Are `parseBlockers`/`parseEscalations`
   actually exposed to the quoted-marker false positive in practice (they parse
   commit *messages*, where the marker is authored by the orchestrator at line
   start), or is the risk confined to agent stdout via `hasBlockerMarker`?
   Architect to rule on whether a git-parser change is warranted this sprint or
   filed as a follow-up; the ruling must be recorded, not silently skipped.
2. **4-space indented code blocks (Edge Case).** Should the fix also suppress
   markers inside 4-space-indented Markdown code blocks, or is fenced-block +
   blockquote suppression sufficient for the observed failure mode? Architect to
   decide scope.
3. **"Honor only in committed messages" alternative.** The backlog item floats
   an alternative fix — only honor the marker in committed commit messages
   rather than raw agent stdout. Is that in scope for this sprint, or is
   line-anchor + fence/quote stripping the agreed approach? (PO recommendation:
   line-anchor + fence/quote stripping, as it directly addresses the observed
   demo-output incident without changing where the marker is read from.)

## Codebase Context
- `hasBlockerMarker` — `src/orchestrator/runner.ts:301-303` (the primary defect site).
- Blocker escalation call site — `src/orchestrator/runner.ts:1194-1225`.
- `parseBlockers` / `parseEscalations` — `src/git-parser.ts:22-61` (secondary review target, AC 6).
- Precedent: Sprint 12 demo false-positive escalation (commit `b4c5ffb`); triaged top-of-queue in Sprint 12 demo feedback (finding 3), precedent Sprint 8 question #4.
