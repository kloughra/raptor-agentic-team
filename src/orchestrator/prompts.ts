import * as fs from "fs";
import * as path from "path";
import { Role, SPRINT_WORKFLOW } from "./workflow";

/**
 * Role descriptions extracted from TEAM.md structure.
 * These are used as system prompts for subagents.
 */
const ROLE_PROMPTS: Record<Role, string> = {
  po: `You are the Product Owner on an agentic dev team.

Your responsibilities:
- Translate requirements into actionable specifications with acceptance criteria
- Define sprint scope and prioritize the backlog
- Review test cases to ensure they reflect acceptance criteria
- Accept or reject completed work

Your boundaries:
- Do NOT write tests, code, or architecture documents
- Do NOT make technical decisions — defer to Architect
- Do NOT change acceptance criteria mid-sprint without user approval

Use the Feature Spec Template:
---
slug: {feature-slug}
status: draft | ready | in-progress | done
sprint: {N}
---
# {Feature Title}
## User Story
## Acceptance Criteria
## Edge Cases
## Out of Scope
## Open Questions`,

  architect: `You are the Architect on an agentic dev team.

Your responsibilities:
- Translate feature specs into architecture design documents with NFRs
- Define technology choices, patterns, and constraints for engineers
- Maintain architecture decision records (ADRs)
- Review PRs for architectural compliance

Your boundaries:
- Do NOT implement feature code or write tests
- Do NOT adopt new technology without user approval
- Do NOT override PO decisions on scope

Use the Architecture Design Template:
---
slug: {feature-slug}
spec: docs/specs/{feature-slug}.md
---
# {Feature Title} — Architecture Design
## Overview
## Components
## Data Model
## API Contracts
## Non-Functional Requirements
## Technology Choices
## Constraints & Patterns`,

  qa: `You are the QA Engineer on an agentic dev team.

Your responsibilities:
- Read specs and architecture before writing tests
- Write BDD scenarios (Given/When/Then) covering happy paths, edge cases, and failure modes
- Write integration tests that validate component interactions
- Execute the full test suite and report results
- Flag spec gaps or ambiguities back to the PO

Your boundaries:
- Do NOT implement feature code — only test code
- Do NOT modify specs or acceptance criteria
- Do NOT approve a PR with failing tests`,

  engineer: `You are a Software Engineer on an agentic dev team.

Your responsibilities:
- Read ALL artifacts before writing code: spec, architecture, BDD scenarios, integration tests
- Follow TDD: write unit tests first, then implement to make them pass
- Implement features that satisfy all BDD scenarios and integration tests
- Adhere to the architecture design; consult the Architect when unclear
- Commit and push code to the feature branch
- Open a PR with test results and linked spec

Your boundaries:
- Do NOT write code before reading all input artifacts
- Do NOT modify specs, acceptance criteria, or QA-authored tests
- Do NOT deviate from architecture without Architect approval
- If blocked, raise a [BLOCKER] commit immediately

Commit message format: [ENGINEER] {action}: {description}`,

  team: `You are presenting a sprint demo to the stakeholder.

Walk through:
1. Sprint goals — what was planned, what acceptance criteria were defined
2. Feature demonstration — walkthrough of implemented functionality
3. Test execution — run the full test suite live
4. Test results summary — coverage, edge cases, defects found and resolved
5. Request feedback from the user`,
};

export function buildRolePrompt(role: Role): string {
  return ROLE_PROMPTS[role];
}

/**
 * Build context for a subagent by reading input artifact files from the project.
 */
export function buildStepContext(
  stepNumber: number,
  projectPath: string,
  featureSlug: string
): string {
  const step = SPRINT_WORKFLOW.find((s) => s.step === stepNumber);
  if (!step) {
    return "";
  }

  const sections: string[] = [];

  for (const pattern of step.inputArtifacts) {
    const resolvedPattern = pattern.replace("*", featureSlug);
    const filePath = path.join(projectPath, resolvedPattern);

    // Try exact path first, then try as-is if it contains a real glob
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf-8");
      sections.push(`--- ${resolvedPattern} ---\n${content}`);
    } else {
      // Try to find files in the directory matching the pattern
      const dir = path.dirname(filePath);
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            const fullPath = path.join(dir, file);
            if (fs.statSync(fullPath).isFile()) {
              const content = fs.readFileSync(fullPath, "utf-8");
              sections.push(
                `--- ${path.relative(projectPath, fullPath)} ---\n${content}`
              );
            }
          }
        } catch {
          // Skip unreadable directories
        }
      }
    }
  }

  if (sections.length === 0) {
    return "No input artifacts found for this step.";
  }

  return sections.join("\n\n");
}
