import * as fs from "fs";
import * as path from "path";
import { SprintState } from "./state";

const DEFAULT_MAX_CONTEXT_CHARS = 10000;

/**
 * Generate a structured sprint summary from artifacts and sprint state.
 * This is deterministic — no LLM call, just file reading and templating.
 */
export function generateSprintSummary(
  projectPath: string,
  projectSlug: string,
  sprint: number,
  state: SprintState
): string {
  const sections: string[] = [];

  sections.push(`# Sprint ${sprint} Summary — ${projectSlug}`);
  sections.push("");

  // Sprint Goal — from backlog
  const sprintGoal = extractSprintGoal(projectPath, sprint);
  sections.push("## Sprint Goal");
  sections.push(sprintGoal || "N/A");
  sections.push("");

  // Features Delivered — from backlog sprint items
  const features = extractFeaturesDelivered(projectPath, sprint);
  sections.push("## Features Delivered");
  if (features.length > 0) {
    for (const f of features) {
      sections.push(`- ${f}`);
    }
  } else {
    sections.push("- N/A");
  }
  sections.push("");

  // Key Technical Decisions — from architecture docs
  const decisions = extractTechDecisions(projectPath);
  sections.push("## Key Technical Decisions");
  if (decisions.length > 0) {
    for (const d of decisions) {
      sections.push(`- ${d}`);
    }
  } else {
    sections.push("- N/A");
  }
  sections.push("");

  // Patterns & Conventions — from architecture docs
  const patterns = extractPatterns(projectPath);
  sections.push("## Patterns & Conventions Established");
  if (patterns.length > 0) {
    for (const p of patterns) {
      sections.push(`- ${p}`);
    }
  } else {
    sections.push("- N/A");
  }
  sections.push("");

  // Issues Encountered — from failure records in state
  const issues = extractIssues(state);
  sections.push("## Issues Encountered");
  if (issues.length > 0) {
    for (const issue of issues) {
      sections.push(`- ${issue}`);
    }
  } else {
    sections.push("- No major issues encountered");
  }
  sections.push("");

  // Deferred Items — from backlog Ready/Inbox
  const deferred = extractDeferredItems(projectPath);
  sections.push("## Deferred Items");
  if (deferred.length > 0) {
    for (const d of deferred) {
      sections.push(`- ${d}`);
    }
  } else {
    sections.push("- None");
  }
  sections.push("");

  // Context for Future Sprints — synthesized
  sections.push("## Context for Future Sprints");
  const contextItems: string[] = [];
  if (decisions.length > 0) contextItems.push(...decisions);
  if (patterns.length > 0) contextItems.push(...patterns);
  if (issues.length > 0) contextItems.push(...issues.map((i) => `Issue: ${i}`));
  if (contextItems.length > 0) {
    sections.push(contextItems.join("\n"));
  } else {
    sections.push("No specific context to carry forward.");
  }
  sections.push("");

  return sections.join("\n");
}

/**
 * Load all sprint summaries from docs/sprints/, bounded by max chars.
 * Returns the concatenated content, most recent first if truncated.
 */
export function loadSprintSummaries(
  projectPath: string,
  maxChars: number = DEFAULT_MAX_CONTEXT_CHARS
): string {
  const sprintsDir = path.join(projectPath, "docs", "sprints");
  if (!fs.existsSync(sprintsDir)) return "";

  const summaryFiles = fs.readdirSync(sprintsDir)
    .filter((f) => /^sprint-\d+-summary\.md$/.test(f))
    .sort((a, b) => {
      const numA = parseInt(a.match(/\d+/)![0], 10);
      const numB = parseInt(b.match(/\d+/)![0], 10);
      return numA - numB;
    });

  if (summaryFiles.length === 0) return "";

  // Read all summaries
  const summaries: { file: string; content: string }[] = [];
  for (const file of summaryFiles) {
    try {
      const content = fs.readFileSync(path.join(sprintsDir, file), "utf-8");
      summaries.push({ file, content });
    } catch {
      // Skip unreadable files
    }
  }

  // Check total size
  const totalChars = summaries.reduce((sum, s) => sum + s.content.length, 0);

  if (totalChars <= maxChars) {
    return summaries.map((s) => s.content).join("\n\n---\n\n");
  }

  // Truncate: include most recent summaries that fit
  const included: string[] = [];
  let usedChars = 0;
  const skipped = [];

  for (let i = summaries.length - 1; i >= 0; i--) {
    if (usedChars + summaries[i].content.length > maxChars && included.length > 0) {
      skipped.push(summaries[i].file);
      continue;
    }
    usedChars += summaries[i].content.length;
    included.unshift(summaries[i].content);
  }

  let result = included.join("\n\n---\n\n");

  if (skipped.length > 0) {
    result = `Note: ${skipped.length} older sprint summaries exist at docs/sprints/ but are not included for brevity.\n\n---\n\n${result}`;
  }

  return result;
}

// --- Internal helpers ---

function extractSprintGoal(projectPath: string, sprint: number): string | null {
  const backlogPath = path.join(projectPath, "docs", "backlog.md");
  if (!fs.existsSync(backlogPath)) return null;

  try {
    const content = fs.readFileSync(backlogPath, "utf-8");
    const sprintMatch = content.match(
      new RegExp(`## Sprint ${sprint}[^]*?(?=\\n## |$)`)
    );
    if (!sprintMatch) return null;

    // Extract first item description
    const itemMatch = sprintMatch[0].match(/- \[[ x]\]\s+([^\n]+)/);
    return itemMatch ? itemMatch[1].trim() : null;
  } catch {
    return null;
  }
}

function extractFeaturesDelivered(projectPath: string, sprint: number): string[] {
  const backlogPath = path.join(projectPath, "docs", "backlog.md");
  if (!fs.existsSync(backlogPath)) return [];

  try {
    const content = fs.readFileSync(backlogPath, "utf-8");
    // Look in Done section for items from this sprint
    const doneMatch = content.match(/## Done\n([\s\S]*?)(?=\n## |$)/);
    if (!doneMatch) return [];

    const items: string[] = [];
    const lines = doneMatch[1].split("\n");
    for (const line of lines) {
      if (line.includes(`Sprint ${sprint}`) && line.includes("[x]")) {
        const itemMatch = line.match(/- \[x\]\s+(.+)/);
        if (itemMatch) items.push(itemMatch[1].trim());
      }
    }
    return items;
  } catch {
    return [];
  }
}

function extractTechDecisions(projectPath: string): string[] {
  const archDir = path.join(projectPath, "docs", "architecture");
  if (!fs.existsSync(archDir)) return [];

  const decisions: string[] = [];
  try {
    const files = fs.readdirSync(archDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(archDir, file), "utf-8");
      // Extract from Technology Choices section
      const techMatch = content.match(/## Technology Choices\n([\s\S]*?)(?=\n## |$)/);
      if (techMatch) {
        const lines = techMatch[1].split("\n").filter((l) => l.includes("|") && !l.includes("---") && !l.includes("Choice"));
        for (const line of lines) {
          const parts = line.split("|").map((p) => p.trim()).filter(Boolean);
          if (parts.length >= 2) {
            decisions.push(`${parts[0]}: ${parts[1]}`);
          }
        }
      }
    }
  } catch {
    // Best effort
  }
  return decisions;
}

function extractPatterns(projectPath: string): string[] {
  const archDir = path.join(projectPath, "docs", "architecture");
  if (!fs.existsSync(archDir)) return [];

  const patterns: string[] = [];
  try {
    const files = fs.readdirSync(archDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(archDir, file), "utf-8");
      const patternMatch = content.match(/## Constraints & Patterns\n([\s\S]*?)(?=\n## |$)/);
      if (patternMatch) {
        const lines = patternMatch[1].split("\n").filter((l) => l.startsWith("- "));
        patterns.push(...lines.map((l) => l.replace(/^- /, "").trim()));
      }
    }
  } catch {
    // Best effort
  }
  return patterns;
}

function extractIssues(state: SprintState): string[] {
  const issues: string[] = [];
  for (const step of state.steps) {
    if (step.failures && step.failures.length > 0) {
      issues.push(
        `Step ${step.step} (${step.name}): failed ${step.failures.length} time(s) before ${step.status === "complete" ? "succeeding" : step.status}`
      );
    }
  }
  return issues;
}

function extractDeferredItems(projectPath: string): string[] {
  const backlogPath = path.join(projectPath, "docs", "backlog.md");
  if (!fs.existsSync(backlogPath)) return [];

  try {
    const content = fs.readFileSync(backlogPath, "utf-8");
    const readyMatch = content.match(/## Ready[^]*?(?=\n## |$)/);
    if (!readyMatch) return [];

    const items: string[] = [];
    const lines = readyMatch[0].split("\n").filter((l) => l.startsWith("- "));
    for (const line of lines) {
      items.push(line.replace(/^- /, "").trim());
    }
    return items;
  } catch {
    return [];
  }
}
