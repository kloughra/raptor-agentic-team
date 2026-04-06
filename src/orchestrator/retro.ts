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

/**
 * Apply selected improvements to TEAM.md content.
 * Returns the updated TEAM.md content.
 */
export function applyImprovements(
  teamMdContent: string,
  proposals: RetroProposal[]
): string {
  let content = teamMdContent;

  for (const proposal of proposals) {
    // Find the target section by header matching
    // Try multiple heading levels
    const patterns = [
      `### ${proposal.section}`,
      `## ${proposal.section}`,
      `# ${proposal.section}`,
    ];

    let sectionIndex = -1;
    let matchedPattern = "";
    for (const pattern of patterns) {
      const idx = content.indexOf(pattern);
      if (idx !== -1) {
        sectionIndex = idx;
        matchedPattern = pattern;
        break;
      }
    }

    if (sectionIndex === -1) {
      // Section not found — skip this proposal
      continue;
    }

    // Find the end of the section (next heading of same or higher level)
    const headingLevel = matchedPattern.split(" ")[0].length; // number of #s
    const sectionEnd = findSectionEnd(content, sectionIndex, headingLevel);

    switch (proposal.type) {
      case "addition": {
        // Insert before the section end
        const insertPoint = sectionEnd;
        const addition = `\n\n> **[Sprint Retro Improvement]** ${proposal.proposal}\n`;
        content = content.slice(0, insertPoint) + addition + content.slice(insertPoint);
        break;
      }
      case "modification": {
        // Add a note at the end of the section
        const insertPoint = sectionEnd;
        const modification = `\n\n> **[Sprint Retro Modification]** ${proposal.proposal}\n`;
        content = content.slice(0, insertPoint) + modification + content.slice(insertPoint);
        break;
      }
      case "removal": {
        // Comment out by adding a note rather than deleting
        const insertPoint = sectionEnd;
        const removal = `\n\n> **[Sprint Retro — Flagged for Removal]** ${proposal.proposal}\n`;
        content = content.slice(0, insertPoint) + removal + content.slice(insertPoint);
        break;
      }
    }
  }

  return content;
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

function findSectionEnd(content: string, sectionStart: number, headingLevel: number): number {
  const afterHeader = content.indexOf("\n", sectionStart);
  if (afterHeader === -1) return content.length;

  // Look for the next heading of the same or higher level
  const rest = content.slice(afterHeader);
  const headingPattern = new RegExp(`^#{1,${headingLevel}} `, "m");
  const nextHeading = rest.search(headingPattern);

  if (nextHeading === -1) return content.length;
  return afterHeader + nextHeading;
}
