import { Role } from "./workflow";
import { SprintState } from "./state";

export interface RetroProposal {
  role: string;
  section: string;
  type: "addition" | "modification" | "removal";
  proposal: string;
  rationale: string;
  impact: string;
}

/**
 * Build a focused retro prompt for a role, asking for one TEAM.md improvement.
 */
export function buildRetroPrompt(
  role: Role,
  teamMd: string,
  sprintContext: string
): string {
  const roleNames: Record<Role, string> = {
    po: "Product Owner",
    architect: "Architect",
    qa: "QA Engineer",
    engineer: "Software Engineer",
    team: "Team",
  };

  return `You are the ${roleNames[role]} reflecting on the sprint that just completed.

Based on your experience this sprint, propose exactly ONE improvement to TEAM.md.

Here is the current TEAM.md:
---
${teamMd}
---

Here is what happened during the sprint:
---
${sprintContext}
---

Respond with EXACTLY this format (fill in the values):

### ${roleNames[role]} Proposal

**Section**: {Which section of TEAM.md this applies to}
**Type**: {addition | modification | removal}
**Proposal**: {What should change, in specific terms}
**Rationale**: {Why, based on what happened this sprint}
**Impact**: {What this would improve for future sprints}

Do NOT include anything else in your response. Just the proposal in the format above.`;
}

/**
 * Parse a retro proposal from agent output.
 * Returns null if the output can't be parsed.
 */
export function parseRetroProposal(
  role: string,
  agentOutput: string
): RetroProposal | null {
  if (!agentOutput || agentOutput.trim().length === 0) return null;

  try {
    const sectionMatch = agentOutput.match(/\*\*Section\*\*:\s*(.+)/);
    const typeMatch = agentOutput.match(/\*\*Type\*\*:\s*(addition|modification|removal)/i);
    const proposalMatch = agentOutput.match(/\*\*Proposal\*\*:\s*(.+)/);
    const rationaleMatch = agentOutput.match(/\*\*Rationale\*\*:\s*(.+)/);
    const impactMatch = agentOutput.match(/\*\*Impact\*\*:\s*(.+)/);

    if (!sectionMatch || !typeMatch || !proposalMatch) return null;

    return {
      role,
      section: sectionMatch[1].trim(),
      type: typeMatch[1].toLowerCase() as "addition" | "modification" | "removal",
      proposal: proposalMatch[1].trim(),
      rationale: rationaleMatch ? rationaleMatch[1].trim() : "No rationale provided",
      impact: impactMatch ? impactMatch[1].trim() : "No impact described",
    };
  } catch {
    return null;
  }
}

/**
 * Generate the retro document from collected proposals.
 */
export function generateRetroDocument(
  projectSlug: string,
  sprint: number,
  proposals: (RetroProposal | null)[],
  roles: string[]
): string {
  const lines: string[] = [];

  lines.push(`# Sprint ${sprint} Retrospective — ${projectSlug}`);
  lines.push("");
  lines.push("## Proposals");
  lines.push("");

  for (let i = 0; i < roles.length; i++) {
    const proposal = proposals[i];
    if (proposal) {
      lines.push(`### ${i + 1}. ${proposal.role.toUpperCase()} Proposal`);
      lines.push("");
      lines.push(`**Section**: ${proposal.section}`);
      lines.push(`**Type**: ${proposal.type}`);
      lines.push(`**Proposal**: ${proposal.proposal}`);
      lines.push(`**Rationale**: ${proposal.rationale}`);
      lines.push(`**Impact**: ${proposal.impact}`);
    } else {
      lines.push(`### ${i + 1}. ${roles[i].toUpperCase()} Proposal`);
      lines.push("");
      lines.push(`No proposal from ${roles[i]}.`);
    }
    lines.push("");
  }

  lines.push("## User Decision");
  lines.push("(Pending user review)");
  lines.push("");
  lines.push("## Applied Changes");
  lines.push("(None yet)");
  lines.push("");

  return lines.join("\n");
}

/**
 * Update the retro document with user decisions.
 */
export function updateRetroDocWithDecisions(
  retroDoc: string,
  adopted: number[],
  totalProposals: number
): string {
  const decisionLines: string[] = [];
  for (let i = 1; i <= totalProposals; i++) {
    const status = adopted.includes(i) ? "Adopted" : "Deferred";
    decisionLines.push(`- Proposal ${i}: ${status}`);
  }

  return retroDoc
    .replace(
      "## User Decision\n(Pending user review)",
      `## User Decision\n${decisionLines.join("\n")}`
    );
}

// ─── Outcome-returning apply pipeline (Sprint 13: retro-improvements-not-applied) ───

export type ProposalPlacement =
  | "applied"
  | "applied-fallback"
  | "already-present"
  | "unplaced";

export interface ProposalOutcome {
  /** proposal.role */
  role: string;
  /** the proposal's requested Section (verbatim) */
  section: string;
  placement: ProposalPlacement;
  /** actual heading text where inserted (first match wins, recorded) */
  placedAt?: string;
  /** required when placement === "unplaced" */
  reason?: string;
}

export interface ApplyImprovementsResult {
  /** updated TEAM.md content */
  content: string;
  /** one entry per input proposal, same order (AC 1 invariant) */
  outcomes: ProposalOutcome[];
  /** content !== input (AC 5 signal) */
  changed: boolean;
}

/**
 * Fallback section for adopted proposals whose target section could not be
 * located (Open Question 3 — Architect decision). Exact string is a contract
 * consumed by tests and future tooling.
 */
export const FALLBACK_SECTION_HEADING = "## Adopted Retro Improvements (Unplaced)";

const FALLBACK_PLACED_AT = "Adopted Retro Improvements (Unplaced)";

const FALLBACK_SECTION_COMMENT =
  "<!-- Proposals adopted at retro review whose target section could not be located.\n" +
  "     Relocate manually; do not delete without applying. -->";

/**
 * Apply selected improvements to TEAM.md content.
 *
 * Every input proposal produces exactly one recorded outcome (AC 1 — no
 * silent drop). Section misses land under FALLBACK_SECTION_HEADING with
 * sprint/role/target-section attribution (AC 2). Idempotency is content-based:
 * a rendered block already present in the content records "already-present"
 * and is never inserted twice (Edge: step-13 re-run/resume).
 */
export function applyImprovements(
  teamMdContent: string,
  proposals: RetroProposal[],
  sprint: number
): ApplyImprovementsResult {
  let content = teamMdContent;
  const outcomes: ProposalOutcome[] = [];

  for (const proposal of proposals) {
    const lines = content.split("\n");
    const heading = resolveHeadingLine(lines, proposal.section);

    if (heading) {
      const block = renderTargetBlock(proposal);
      if (content.includes(block)) {
        outcomes.push({
          role: proposal.role,
          section: proposal.section,
          placement: "already-present",
          placedAt: heading.text,
        });
        continue;
      }
      const endLine = findSectionEndLine(lines, heading.lineIdx, heading.level);
      lines.splice(endLine, 0, "", block, "");
      content = lines.join("\n");
      outcomes.push({
        role: proposal.role,
        section: proposal.section,
        placement: "applied",
        placedAt: heading.text,
      });
    } else {
      // Section miss → fallback, never dropped (AC 2). The rendered marker
      // embeds the sprint number, making blocks sprint-unique for the
      // content-based idempotency check.
      const block = renderFallbackBlock(proposal, sprint);
      if (content.includes(block)) {
        outcomes.push({
          role: proposal.role,
          section: proposal.section,
          placement: "already-present",
          placedAt: FALLBACK_PLACED_AT,
        });
        continue;
      }
      content = insertIntoFallbackSection(content, block);
      outcomes.push({
        role: proposal.role,
        section: proposal.section,
        placement: "applied-fallback",
        placedAt: FALLBACK_PLACED_AT,
      });
    }
  }

  return { content, outcomes, changed: content !== teamMdContent };
}

/**
 * Update the retro document's "## Applied Changes" section with one line per
 * outcome (AC 3). Pure string-replace on the "(None yet)" stub, mirroring
 * updateRetroDocWithDecisions. If the stub is absent (re-run, hand-edited
 * doc), returns the input unchanged — graceful degradation, best-effort.
 */
export function updateRetroDocWithAppliedChanges(
  retroDoc: string,
  outcomes: ProposalOutcome[]
): string {
  const stub = "## Applied Changes\n(None yet)";
  if (!retroDoc.includes(stub) || outcomes.length === 0) return retroDoc;

  const lines = outcomes.map((o) => {
    const role = o.role.toUpperCase();
    switch (o.placement) {
      case "applied":
        return `- ${role} proposal → applied at "${o.placedAt}"`;
      case "already-present":
        return `- ${role} proposal → already present at "${o.placedAt}"`;
      case "applied-fallback":
        return `- ${role} proposal → fallback ("${FALLBACK_PLACED_AT}"); target "${o.section}" not found`;
      case "unplaced":
        return `- ${role} proposal → NOT APPLIED: ${o.reason ?? "unknown reason"}`;
    }
  });

  return retroDoc.replace(stub, `## Applied Changes\n${lines.join("\n")}`);
}

/**
 * Build a sprint context summary for retro prompts.
 */
export function buildSprintContextForRetro(state: SprintState): string {
  const lines: string[] = [];
  lines.push(`Sprint ${state.sprint} for project ${state.project}`);
  lines.push(`Status: ${state.status}`);
  lines.push("");
  lines.push("Steps completed:");

  for (const step of state.steps) {
    let detail = `  ${step.step}. ${step.name} (${step.role}): ${step.status}`;
    if (step.failures && step.failures.length > 0) {
      detail += ` — failed ${step.failures.length} time(s)`;
    }
    lines.push(detail);
  }

  if (state.checkpoints.length > 0) {
    lines.push("");
    lines.push("Checkpoints:");
    for (const cp of state.checkpoints) {
      lines.push(`  ${cp.type}: ${cp.status}${cp.feedback ? ` — feedback: ${cp.feedback}` : ""}`);
    }
  }

  return lines.join("\n");
}

/**
 * Parse user feedback for retro selection.
 * Returns array of 1-based proposal indices to adopt.
 */
export function parseRetroSelection(
  feedback: string | undefined | null,
  totalProposals: number
): number[] {
  if (!feedback || feedback.trim() === "" || feedback.trim().toLowerCase() === "skip") {
    return [];
  }

  if (feedback.trim().toLowerCase() === "all") {
    return Array.from({ length: totalProposals }, (_, i) => i + 1);
  }

  // Parse comma-separated indices
  const indices = feedback
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n >= 1 && n <= totalProposals);

  return indices;
}

// --- Internal helpers ---

/**
 * Normalize heading/section text for matching (Open Question 2 — Architect
 * ruling): trim, lowercase, collapse internal whitespace, strip a leading
 * `#`-run (agents sometimes echo the hashes). Deliberately NO fuzzy,
 * substring, or prefix matching — a wrong-section placement is worse than a
 * well-attributed fallback.
 */
function normalizeHeadingText(text: string): string {
  return text
    .trim()
    .replace(/^#+\s*/, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isFenceLine(line: string): boolean {
  return line.trimStart().startsWith("```");
}

interface HeadingLine {
  lineIdx: number;
  level: number;
  /** verbatim heading text (hashes stripped, trimmed) — recorded in placedAt */
  text: string;
}

/**
 * Line-based heading scan. Tracks fenced-code state (``` toggles); headings
 * inside fences are non-matchable (Edge Case: TEAM.md embeds templates with
 * `#` headings inside code fences). First match in document order wins.
 */
function findHeadingLine(lines: string[], section: string): HeadingLine | null {
  const target = normalizeHeadingText(section);
  if (target === "") return null;

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (isFenceLine(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (m && normalizeHeadingText(m[2]) === target) {
      return { lineIdx: i, level: m[1].length, text: m[2].trim() };
    }
  }
  return null;
}

// ─── Segment-and-match resolver ────────────────────────────────────────────
// Sprint 15 (retro-section-matching-rarely-hits-target). Open Question 1 →
// option (b): apply-side only. `resolveHeadingLine` runs the existing
// normalized-exact matcher FIRST (byte-identical fast path), then a
// segment-and-match pass that lets a compound/descriptive Section string
// resolve to the real TEAM.md heading it references. When nothing resolves it
// returns null and the unchanged Sprint 13 fallback fires (AC 4 — precision
// over recall; a well-attributed fallback beats a confident-but-wrong
// placement). Deterministic, string-only, no model call (AC 5).

/** Extracted real heading candidate (fence-aware). */
interface RealHeading {
  lineIdx: number;
  level: number;
  /** verbatim heading text (hashes stripped) → recorded in placedAt */
  text: string;
  /** core match tokens (trailing parenthetical stripped, lowercased) */
  core: string[];
  /** 0-based document order among non-fenced headings */
  docIdx: number;
}

/**
 * Strip a heading's TRAILING parenthetical qualifier when computing core tokens
 * (Architect ruling, Open Question 3): `Product Owner (PO)` → `Product Owner`;
 * `Software Engineer(s)` → `Software Engineer`. Only a final `(...)` group at
 * end-of-string is treated as an optional qualifier — a mid-string parenthetical
 * is left in place.
 */
function stripTrailingParenthetical(text: string): string {
  return text.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/**
 * Whole-word tokenization: lowercase, then split on any run of non-alphanumeric
 * characters. `&`, `(`, `)`, `-`, and whitespace all delimit. Empty tokens
 * dropped. Whole-token equality is what kills substring false positives —
 * `architect` never equals the token `architecture` (AC 4).
 */
function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Fence-aware scan producing the candidate heading index in document order.
 * Headings inside fenced code blocks are excluded (AC 6 — reuses the same
 * `isFenceLine` toggle as `findHeadingLine` / `findSectionEndLine`).
 */
function extractRealHeadings(lines: string[]): RealHeading[] {
  const out: RealHeading[] = [];
  let inFence = false;
  let docIdx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (isFenceLine(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const text = m[2].trim();
    const core = tokenizeWords(stripTrailingParenthetical(text));
    if (core.length === 0) continue; // parenthetical-only heading → un-matchable
    out.push({ lineIdx: i, level: m[1].length, text, core, docIdx: docIdx++ });
  }
  return out;
}

/**
 * Split a free-text Section into segments on STRONG separators only. Arrow
 * forms (`→` / `->` / `=>` / `»` / `▸`) are normalized to `;` first, then the
 * string is split on `; : , / | >` and newlines. `-` and `&` are DELIBERATELY
 * NOT separators — they appear inside legitimate headings (`Roles &
 * Responsibilities`, `Multi-Engineer Coordination`, `Cross-Review
 * Expectations`), so splitting on them would shred a real heading (AC 4
 * no-shred edge case).
 */
function segmentSection(section: string): string[] {
  return section
    .replace(/→|->|=>|»|▸/g, ";")
    .split(/[;:,/|>\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * True when `needle` appears as a contiguous whole-token subsequence of `hay`.
 * An empty needle never matches (guards against matching everything).
 */
function isContiguousSubsequence(hay: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Resolve a free-text Section to a real TEAM.md heading. Returns the same
 * `HeadingLine | null` shape as `findHeadingLine`, so `applyImprovements` is
 * unchanged apart from its single call-site swap.
 *
 * Pipeline:
 *   1. Exact fast path — `findHeadingLine` (unchanged). A verbatim heading
 *      resolves byte-identically to pre-feature behavior.
 *   2. Segment the Section on strong separators; tokenize each segment.
 *   3. A heading is a candidate when its core token sequence is a contiguous
 *      whole-token subsequence of a single segment (first matching segment).
 *   4. Deterministic winner: longest match ↓, deepest level ↓, earliest
 *      segment ↑, document order ↑ (Architect tie-break ruling, Open Q 2).
 *   5. No candidate → null → caller falls back (AC 4).
 */
function resolveHeadingLine(lines: string[], section: string): HeadingLine | null {
  // 1. Exact fast path — byte-identical to the pre-feature matcher.
  const exact = findHeadingLine(lines, section);
  if (exact) return exact;

  // 2. Segment-and-match.
  const segmentTokens = segmentSection(section).map(tokenizeWords);
  if (segmentTokens.length === 0) return null;

  const headings = extractRealHeadings(lines);
  const candidates: Array<{ heading: RealHeading; matchLen: number; segIdx: number }> = [];

  for (const h of headings) {
    for (let s = 0; s < segmentTokens.length; s++) {
      if (isContiguousSubsequence(segmentTokens[s], h.core)) {
        candidates.push({ heading: h, matchLen: h.core.length, segIdx: s });
        break; // earliest matching segment for this heading
      }
    }
  }
  if (candidates.length === 0) return null;

  // 4. Deterministic total-order winner.
  candidates.sort((a, b) => {
    if (b.matchLen !== a.matchLen) return b.matchLen - a.matchLen; // longest match
    if (b.heading.level !== a.heading.level) return b.heading.level - a.heading.level; // deepest
    if (a.segIdx !== b.segIdx) return a.segIdx - b.segIdx; // earliest segment
    return a.heading.docIdx - b.heading.docIdx; // document order
  });

  const winner = candidates[0].heading;
  return { lineIdx: winner.lineIdx, level: winner.level, text: winner.text };
}

/**
 * Find the line index where the section starting at headingLineIdx ends: the
 * next heading of the same or higher level OUTSIDE any code fence (a fenced
 * heading never terminates a section early), or the end of the document.
 */
function findSectionEndLine(
  lines: string[],
  headingLineIdx: number,
  headingLevel: number
): number {
  let inFence = false;
  for (let i = headingLineIdx + 1; i < lines.length; i++) {
    if (isFenceLine(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= headingLevel) return i;
  }
  return lines.length;
}

/** Blockquote markers for target-section insertion (pre-existing formats). */
function renderTargetBlock(proposal: RetroProposal): string {
  const markers: Record<RetroProposal["type"], string> = {
    addition: "Sprint Retro Improvement",
    modification: "Sprint Retro Modification",
    removal: "Sprint Retro — Flagged for Removal",
  };
  return `> **[${markers[proposal.type]}]** ${proposal.proposal}`;
}

/**
 * Fallback entry marker — attribution (sprint + role + intended section +
 * type) inline (AC 2 / Open Question 3). Exact shape is a contract.
 */
function renderFallbackBlock(proposal: RetroProposal, sprint: number): string {
  return `> **[Sprint ${sprint} Retro — ${proposal.role.toUpperCase()}, target section: "${proposal.section}"]** (${proposal.type}) ${proposal.proposal}`;
}

/**
 * Insert a fallback entry under FALLBACK_SECTION_HEADING, creating the
 * section at the end of the document if absent.
 */
function insertIntoFallbackSection(content: string, block: string): string {
  const lines = content.split("\n");
  let heading = findHeadingLine(lines, FALLBACK_SECTION_HEADING);

  if (!heading) {
    // Trim trailing blank lines, then append the section at document end.
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    lines.push("", FALLBACK_SECTION_HEADING, "", FALLBACK_SECTION_COMMENT);
    heading = {
      lineIdx: lines.length - 3,
      level: 2,
      text: FALLBACK_PLACED_AT,
    };
  }

  const endLine = findSectionEndLine(lines, heading.lineIdx, heading.level);
  lines.splice(endLine, 0, "", block);

  // Preserve a trailing newline at document end.
  if (lines[lines.length - 1].trim() !== "") lines.push("");
  return lines.join("\n");
}
