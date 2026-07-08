---
slug: blocker-marker-false-positive-in-agent-output
spec: docs/specs/blocker-marker-false-positive-in-agent-output.md
---
# Blocker-Marker False Positive in Agent Output — Architecture Design

## Overview

Today `hasBlockerMarker` (`src/orchestrator/runner.ts:301-303`) is a one-liner:

```ts
function hasBlockerMarker(output: string): boolean {
  return /\[blocker\]/i.test(output);
}
```

It tests the bare marker **anywhere** in the entire agent-output string. Any
occurrence — inside a fenced code block, a Markdown blockquote, or prose that
merely *documents* the marker convention — drives an immediate `[ESCALATE]`
commit + early return. This is a confirmed live defect: Sprint 12 step 8 (Demo,
commit `b4c5ffb`) escalated because the demo presentation quoted a
decision-pipeline diagram containing the literal marker.

This design **hardens detection** — it changes *what counts as* a blocker
marker, not what happens once one is detected. The escalation mechanics, commit
format, retry/circuit-breaker pipeline, and `SprintState` schema are all frozen
(AC 7, Out of Scope).

The fix is a single pure line-scanner that treats a marker as real only when it
appears **line-anchored** (start of line, leading whitespace tolerated) and
**not suppressed** (not inside a fenced code block or a blockquote). The same
suppression primitive is applied defensively to the two `git-parser.ts` commit-
message parsers (AC 6 ruling — see Open Questions).

### Verified facts (provenance)

| Claim | Source (verified this sprint) |
|-------|-------------------------------|
| `hasBlockerMarker` is `/\[blocker\]/i.test(output)` | `runner.ts:301-303` |
| Called at **two** seams, not one | `runner.ts:1196` (single-feature), `runner.ts:1951` (multi-feature) |
| Only consumer of `hasBlockerMarker` is `runner.ts` | grep: no other file references it |
| Single-feature seam → escalation commit + early return | `runner.ts:1196-1226` |
| Multi-feature seam → `{ kind: "blocker" }`, consumed at `runner.ts:2191` / finalized at `:2378` | `runner.ts:1951-1962`, `:1768` (union type) |
| Escalation commit embeds a mid-line `[BLOCKER]` | `runner.ts:1213`: ``[ESCALATE] … agent raised [BLOCKER]: …`` |
| `parseBlockers` / `parseEscalations` match anywhere-in-message | `git-parser.ts:26-28`, `:47-49` |
| Fence-scan precedent (``` only, not `~~~`) exists in retro | `retro.ts:365-391` (private `isFenceLine` / `inFence`) |

> **Correction to spec Codebase Context:** the spec lists only the single-feature
> seam (`runner.ts:1194-1225`). There is a **second production seam** at
> `runner.ts:1951` (multi-feature loop). Both must route through the hardened
> function. This mirrors the Sprint 14 "two production seams" pattern and is a
> mandatory acceptance concern for QA rule 12 (test parity at both seams).

## Components

### New module: `src/orchestrator/blocker-marker.ts` (pure, dependency-free leaf)

Extract marker detection out of `runner.ts` into a dedicated pure module. This
gives us **one** implementation of the suppression semantics (honoring the
"single matching implementation" pattern from `glob-match` / retro one-impl-two-
seams), makes it directly unit-testable, and keeps `runner.ts` unchanged in
behavior at both seams.

Exports:

- `hasBlockerMarker(output: string): boolean` — the hardened detector. Replaces
  the private function in `runner.ts`; both seams import and call it (no change
  to call-site logic, only the import).
- `stripSuppressedLines(text: string): string` — the reusable primitive that
  removes fenced-code and blockquote lines, returning the remaining text. Used
  by `hasBlockerMarker` and by `git-parser.ts`.

The module imports **nothing** (no `fs`, no orchestrator modules), so
`git-parser.ts` (a root-level leaf) importing `stripSuppressedLines` from it
introduces **no dependency cycle** — the edge points into a pure leaf. (Convention
note: new orchestrator code lives under `src/orchestrator/`; this module honors
that while remaining import-free so the root-level parser can safely depend on it.)

### Modified: `src/orchestrator/runner.ts`

- Delete the private `hasBlockerMarker` (lines 301-303).
- `import { hasBlockerMarker } from "./blocker-marker";`
- Both call sites (`:1196`, `:1951`) unchanged in structure — they call the
  imported function. **No change** to the escalation commit, the early-return
  contract, the `{ kind: "blocker" }` union, or downstream handling
  (`:2191`, `:2378`).

### Modified: `src/git-parser.ts` (AC 6 — defensive hardening)

- `import { stripSuppressedLines } from "./orchestrator/blocker-marker";`
- In `parseBlockers` and `parseEscalations`, run the commit message through
  `stripSuppressedLines` and **line-anchor** the existing grammar regexes
  (prepend `^\s*`, add the `m` flag). Return shapes and the
  `[BLOCKER] Role: desc -- blocked on Role` / `[ESCALATE] Role: desc` grammars
  are **unchanged** (Out of Scope forbids reworking them) — only *where* the
  match anchors and *what body text is excluded* change, which is explicitly
  in-scope.

## Data Model

**No changes.** No new persisted state, no `SprintState` migration (AC 7, Out of
Scope). `BlockerEntry` / `EscalationEntry` / `GitLogEntry` shapes are unchanged.
The feature is pure string logic operating on in-memory agent output and commit
messages.

## API Contracts

### `hasBlockerMarker(output: string): boolean`

Returns `true` iff `output` contains at least one **genuine** blocker marker.

A line qualifies as a genuine marker when **all** hold:
1. After `String.prototype.trimStart()`, the line matches `/^\[blocker\]/i`
   (case-insensitive; leading whitespace/tabs tolerated).
2. The line is **not** inside a fenced code block (```` ``` ````- or `~~~`-delimited).
3. The line is **not** a blockquote (does not begin, after trimStart, with `>`).

Detection algorithm (single O(n) forward pass, no backtracking):

```
hasBlockerMarker(output):
  if not output: return false
  inFence = false; fenceToken = null
  for raw in output.split(/\r?\n/):          # AC: CRLF and LF both handled
    line = raw.trimStart()
    if line starts with "```" or "~~~":
      token = the matched delimiter (3+ backticks -> "```", else "~~~")
      if not inFence:      inFence = true;  fenceToken = token
      elif token == fenceToken: inFence = false; fenceToken = null
      # a different delimiter while open stays inside the fence (conservative)
      continue
    if inFence:            continue          # AC 2: fenced markers suppressed
    if line startsWith ">": continue         # AC 3: blockquote markers suppressed
    if /^\[blocker\]/i.test(line): return true   # AC 1, 5: line-anchored, case-insensitive
  return false
```

**Contract invariants (for QA):**
- Empty / whitespace-only / marker-free output → `false` (unchanged).
- Marker mid-line in prose → `false` (AC 1 / Edge Case).
- Marker line-anchored with trailing text (`[BLOCKER] QA: cannot find spec`) → `true` (Edge Case).
- Marker line-anchored with leading whitespace/tab, not fenced/quoted → `true` (Edge Case).
- Marker only inside ```` ``` ````/`~~~` fence → `false` (AC 2).
- Marker only inside `>` blockquote → `false` (AC 3).
- Multiple markers, ≥1 genuine line-anchored → `true` (Edge Case).
- Unclosed fence → remainder treated as inside the fence → suppressed (Edge Case; see NFR "conservative bias").
- CRLF vs LF → identical result (Edge Case).

### `stripSuppressedLines(text: string): string`

Returns `text` with all fenced-code lines (including the fence delimiters) and
all blockquote lines removed, preserving the remaining lines' order and their
line boundaries so that a subsequent `m`-flag `^`-anchored match behaves
correctly. Used to pre-filter commit messages in `git-parser.ts`.

### `parseBlockers` / `parseEscalations` (`git-parser.ts`)

Signatures and return shapes **unchanged**. Behavior change: a marker is
recognized only when it is line-anchored (`^\s*[BLOCKER]…` / `^\s*[ESCALATE]…`,
`m` flag) in the **suppressed** message body. This eliminates two false
positives:
1. The marker quoted inside a commit's fenced/blockquoted body.
2. The embedded mid-line `[BLOCKER]` inside the orchestrator's own
   `[ESCALATE] … agent raised [BLOCKER]: …` commit (`runner.ts:1213`), which the
   current anywhere-match `parseBlockers` can mis-read as a blocker entry.

## Non-Functional Requirements

| NFR | Requirement | Rationale / Verification |
|-----|-------------|--------------------------|
| **Performance** | Detection is a single O(n) forward line-scan over the output; target < 5 ms for a 1 MB output; negligible delta vs the current single regex. No nested loops, no catastrophic-backtracking regex. | Agent outputs are typically < 100 KB. QA performance test asserts bounded runtime on a large (~1 MB) synthetic input. |
| **Correctness (conservative bias)** | When ambiguous (e.g. an unclosed fence), suppress rather than escalate — bias toward **false-negative on detection** (miss a marker) over **false-positive escalation**. This is the entire point of the feature: a false escalation costs operator time; a genuinely blocked agent has other signals (non-zero exit, missing outputs) that still drive the retry/circuit-breaker path. | Spec Edge Case ("conservative: suppress false positives unless Architect rules otherwise") — **Architect confirms conservative suppression.** |
| **Backward compatibility** | Escalation mechanics, `[ESCALATE]` commit format, early-return contract, `{kind:"blocker"}` union, retry/circuit-breaker thresholds, and `SprintState` schema are byte-for-byte unchanged. A genuine line-anchored blocker escalates exactly as today. | AC 4, AC 7. QA production-seam test asserts identical escalation for a genuine marker. |
| **Reliability / robustness** | Pure string ops on untrusted agent stdout — no exceptions on any input (empty, huge, binary-ish, mixed line endings). Never throws. | AC edge cases; input is untrusted subagent output (existing "subagent output is untrusted" convention). |
| **Security** | No code execution, no filesystem, no shell. Linear-time regex only (no ReDoS surface). | Untrusted-input handling. |
| **Testability** | Pure, dependency-free function → unit-testable in isolation; both runner seams and both git-parser functions covered; ≥1 production-seam test. | AC 8, AC 9; TEAM.md QA rule 12. |
| **Maintainability** | One implementation of the suppression primitive, shared by runner and git-parser. No duplicated fence/quote logic. | "Single matching implementation" pattern. |

## Technology Choices

*Presented for user/PO approval. **No new technology is adopted** — all choices
are existing stack primitives.*

| Concern | Choice | Notes |
|---------|--------|-------|
| Language / runtime | TypeScript on Node.js (existing) | No new deps. |
| Detection engine | Hand-rolled single-pass line scanner + simple anchored regex (`/^\[blocker\]/i`, `/^(```|~~~)/`) | Deliberately **not** a Markdown parser — no `markdown-it`/`remark` dependency. The spec scopes this to structural line rules (line-anchor + fence/blockquote), not full CommonMark. Adding a Markdown parser would be new tech requiring approval and is unjustified. |
| Line splitting | `output.split(/\r?\n/)` | CRLF/LF handling (Edge Case). |
| Module location | New pure leaf `src/orchestrator/blocker-marker.ts` | Import-free so `git-parser.ts` can depend on it without a cycle. |
| Shared primitive | `stripSuppressedLines` reused by both surfaces | One implementation (pattern compliance). |
| Tests | jest / ts-jest — colocated unit (`src/orchestrator/blocker-marker.test.ts`), production-seam integration under `tests/integration/`, BDD `tests/bdd/blocker-marker-false-positive-in-agent-output.feature` | Existing test stack. |
| Git operations (git-parser callers unchanged) | `simple-git` (existing) | No shelling out. |

## Constraints & Patterns

- **Detection-only change.** This feature changes *what counts as* a blocker
  marker. It MUST NOT touch escalation mechanics, the `[ESCALATE]` commit format
  (`runner.ts:1213`), the early-return contract, the `{kind:"blocker"}` union
  (`runner.ts:1768`, `:1961`), downstream handling (`:2191`, `:2378`), the
  retry/circuit-breaker pipeline, or `SprintState` (AC 7, Out of Scope).
- **Both seams route through one function.** `runner.ts:1196` (single-feature)
  **and** `runner.ts:1951` (multi-feature) call the same imported
  `hasBlockerMarker`. No forked logic. QA rule 12 requires parity asserted **at
  each seam**, not only on the pure function.
- **Single suppression implementation.** `stripSuppressedLines` is the one place
  fence/blockquote suppression lives; `hasBlockerMarker` and `git-parser.ts`
  both consume it. No copy-pasted fence loop (the `retro.ts` private `inFence`
  loop is precedent, not a shared API, and only handles ```` ``` ````; do not
  duplicate it — the new module additionally handles `~~~`).
- **Leading whitespace is tolerated; 4-space indent is NOT code** (OQ2 ruling
  below). A genuinely raised blocker may be indented; suppressing indented lines
  would risk swallowing real blockers (false-negative escalation).
- **Conservative on ambiguity.** Unclosed fence ⇒ suppress the remainder. Favor
  missing a marker over a false escalation.
- **Untrusted input; never throws.** Pure string ops; all edge inputs return a
  boolean.
- **RED-verification discipline (TEAM.md QA rule 12).** Every constraint-guarding
  test carries a RED note proving it FAILS against the pre-change anywhere-match
  implementation. The Sprint 12 incident (fenced/quoted marker ⇒ `false`) and a
  companion line-anchored case (⇒ `true`) are mandatory (AC 8). At least one test
  drives the **real runner path** (AC 9), not only the pure function.

## Open Questions — Architect Rulings

**OQ1 — git-parser exposure (AC 6): RULING — fix this sprint (defensive
line-anchoring + suppression).**
`parseBlockers`/`parseEscalations` parse commit *messages*, and the structured
grammars (`[BLOCKER] Role: … -- blocked on Role`, `[ESCALATE] Role: …`) already
provide strong protection against casual quoting. However there is a **concrete
latent false positive**: the orchestrator's own escalation commit
(`runner.ts:1213`) is ``[ESCALATE] … agent raised [BLOCKER]: <output>``, and the
current anywhere-match `parseBlockers` can mis-read that embedded mid-line
`[BLOCKER]` as a blocker entry (and a truncated output containing
`-- blocked on X` would complete the grammar). Because the fix is cheap, in-scope
("where a match is anchored / what body text is excluded"), and removes a real
bug, we **apply line-anchoring + `stripSuppressedLines` to both parsers this
sprint**. Return shapes and grammars are untouched. This is recorded here rather
than silently skipped, per AC 6.

**OQ2 — 4-space indented code blocks: RULING — OUT of scope; do NOT suppress.**
Fenced-block (AC 2) + blockquote (AC 3) suppression fully covers the observed
Sprint 12 failure mode (a fenced diagram). Treating 4-space indentation as code
would (a) conflict with the Edge Case that an indented-but-not-fenced marker **is**
a genuine blocker, and (b) create false-negative escalation risk — a real blocker
emitted with leading indentation would be silently swallowed. Indentation is
ambiguous (list continuations, wrapped prose). Fence + blockquote suppression is
sufficient. Recorded, not skipped.

**OQ3 — "honor only in committed messages" alternative: RULING — rejected; keep
reading raw agent stdout with line-anchor + fence/quote stripping.**
Detection currently runs on stdout **before** any commit, enabling immediate
escalation. Moving to commit-message-only detection would change *where* and
*when* the marker is read — a behavioral change to escalation timing that AC 7
freezes and Out of Scope forbids. The line-anchor + fence/quote approach directly
addresses the observed demo-output incident without moving the read site. Aligns
with the PO recommendation.

## Handoff to QA

Test matrix (each constraint-guarding test carries a RED-verification note vs the
pre-change `/\[blocker\]/i` anywhere-match):

1. **Unit (`blocker-marker.test.ts`)** — every API-contract invariant above:
   prose mid-line → false; line-anchored (+trailing text, +leading ws) → true;
   fenced (```` ``` ```` and `~~~`) → false; blockquote → false; multi-marker
   mixed → true; unclosed fence → false; CRLF/LF parity; empty → false;
   case-insensitivity.
2. **Regression (AC 8)** — reproduce the Sprint 12 incident: a demo-style output
   whose only marker sits inside a fenced decision-pipeline diagram → `false`;
   companion line-anchored raise → `true`.
3. **Production-seam (AC 9)** — drive the **real runner path** at **both** seams
   (single-feature `:1196` and multi-feature `:1951`): quoted/fenced marker
   produces **no** `[ESCALATE]` and the step proceeds; a genuine line-anchored
   `[BLOCKER]` **does** escalate (commit + early return / `{kind:"blocker"}`),
   byte-identical to today's escalation.
4. **git-parser (AC 6)** — a commit message quoting the marker in a fence/
   blockquote body → not parsed as a blocker/escalation; the orchestrator's
   `[ESCALATE] … agent raised [BLOCKER]: …` commit → parsed as exactly one
   escalation and **zero** blockers; a genuine `[BLOCKER] Role: … -- blocked on
   Role` at message start → parsed as one blocker.
5. **Performance** — bounded runtime on a ~1 MB synthetic output.
