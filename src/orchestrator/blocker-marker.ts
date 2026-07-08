/**
 * Blocker-marker detection — hardened, line-anchored, fence/quote-aware.
 *
 * Spec:         docs/specs/blocker-marker-false-positive-in-agent-output.md
 * Architecture: docs/architecture/blocker-marker-false-positive-in-agent-output.md
 *
 * This module is the SINGLE implementation of blocker-marker suppression
 * semantics. It is a pure, dependency-free leaf: it imports NOTHING (no `fs`,
 * no orchestrator modules), so `src/git-parser.ts` (a root-level leaf) can
 * depend on it without introducing a dependency cycle — the edge points into a
 * pure leaf.
 *
 * WHAT THIS CHANGES: only *what counts as* a genuine `[BLOCKER]` marker — never
 * what happens once one is detected. The escalation mechanics, `[ESCALATE]`
 * commit format, retry/circuit-breaker pipeline, and `SprintState` schema are
 * all frozen (AC 7 / Out of Scope).
 *
 * A line qualifies as a genuine marker when ALL of these hold:
 *   1. After `trimStart()`, the line matches `/^\[blocker\]/i` (case-insensitive;
 *      leading whitespace/tabs tolerated).
 *   2. The line is NOT inside a fenced code block (``` - or ~~~ -delimited).
 *   3. The line is NOT a blockquote (does not begin, after `trimStart()`, with `>`).
 *
 * Conservative bias (NFR): when ambiguous (e.g. an unclosed fence), suppress
 * rather than escalate — a false escalation costs operator time; a genuinely
 * blocked agent has other signals (non-zero exit, missing outputs).
 */

const LINE_ANCHORED_BLOCKER = /^\[blocker\]/i;

/** True if a (post-`trimStart`) line opens or closes a fenced code block. */
function fenceTokenOf(trimmed: string): "```" | "~~~" | null {
  if (trimmed.startsWith("```")) return "```";
  if (trimmed.startsWith("~~~")) return "~~~";
  return null;
}

/**
 * Detect whether `output` contains at least one genuine (line-anchored,
 * non-fenced, non-blockquoted) `[BLOCKER]` marker.
 *
 * Single O(n) forward pass over the lines — no backtracking, no nested loops.
 * Never throws on any input; returns a boolean for all inputs (AC reliability).
 */
export function hasBlockerMarker(output: string): boolean {
  if (!output) return false;

  let inFence = false;
  let fenceToken: "```" | "~~~" | null = null;

  // Split on both CRLF and LF so line-anchoring works for either ending.
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimStart();

    const token = fenceTokenOf(line);
    if (token) {
      if (!inFence) {
        inFence = true;
        fenceToken = token;
      } else if (token === fenceToken) {
        inFence = false;
        fenceToken = null;
      }
      // A different delimiter while a fence is open stays inside the fence
      // (conservative). Either way, a fence-delimiter line is never a marker.
      continue;
    }

    if (inFence) continue; // AC 2: fenced markers suppressed.
    if (line.startsWith(">")) continue; // AC 3: blockquote markers suppressed.

    if (LINE_ANCHORED_BLOCKER.test(line)) return true; // AC 1, 5.
  }

  return false;
}

/**
 * Remove all fenced-code lines (including the fence delimiters themselves) and
 * all blockquote lines from `text`, preserving the remaining lines' order and
 * their line boundaries so that a subsequent `m`-flag `^`-anchored match behaves
 * correctly.
 *
 * Shared suppression primitive: used by `hasBlockerMarker` semantics and by the
 * `git-parser.ts` commit-message parsers. Never throws.
 */
export function stripSuppressedLines(text: string): string {
  if (!text) return "";

  // Detect the line ending to preserve boundaries on re-join (CRLF vs LF).
  const usesCRLF = text.includes("\r\n");
  const eol = usesCRLF ? "\r\n" : "\n";

  const kept: string[] = [];
  let inFence = false;
  let fenceToken: "```" | "~~~" | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimStart();

    const token = fenceTokenOf(line);
    if (token) {
      if (!inFence) {
        inFence = true;
        fenceToken = token;
      } else if (token === fenceToken) {
        inFence = false;
        fenceToken = null;
      }
      continue; // Drop the fence delimiter line itself.
    }

    if (inFence) continue; // Drop fenced-code body.
    if (line.startsWith(">")) continue; // Drop blockquote lines.

    kept.push(raw);
  }

  return kept.join(eol);
}
