import * as fs from "fs";
import * as path from "path";
import { Role, SPRINT_WORKFLOW } from "./workflow";
import { classifyPattern, matchExpectedOutput } from "./glob-match";
import { DinoIdentity, resolveDinoNames, buildDinoIdentityPreamble } from "./dino";

const TEAM_MD_MAX_SIZE = 8 * 1024; // 8KB cap for TEAM.md injection

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

/**
 * Adversarial-verifier gate instruction (adversarial-verifier-review-gate,
 * Sprint 14 — Part 1, AC 1–4/17). Centralized here (not inlined in runner.ts)
 * precisely so a test can assert its presence in the step-7 QA agent's prompt
 * (AC 2). The runner appends this to the step-7 "Run test suite" QA task, so the
 * enforcement is ORCHESTRATED — it takes effect for every sprint without a human
 * having read TEAM.md.
 *
 * Content contract (pinned by the AC-1..4 tests):
 *  - Act as an out-of-loop adversarial verifier.
 *  - (a) Hunt for tests that reimplement/stub the system-under-test instead of
 *        exercising the real production seam.
 *  - (b) Confirm constraint-guarding tests carry a RED-verification note
 *        (proven to fail pre-change), while NOT demanding one on ordinary tests.
 *  - Bias toward the false-negative (reject suspicious-but-plausible work).
 *  - On detecting either failure: flag/fail and surface it — never pass silently.
 */
export function buildAdversarialGateSection(): string {
  return `--- Adversarial Verifier Review Gate ---
You are acting as an OUT-OF-LOOP ADVERSARIAL VERIFIER for this review gate — not a
collaborator trying to help the work pass, but a skeptic trying to prove it is
false-green. A sprint must never report "all tests pass" when the tests secretly
fail to exercise the real system.

Carry out these checks against the production seams:

(a) Reimplementation / stub hunt. Inspect the tests for any that REIMPLEMENT or
    STUB the system-under-test instead of exercising the real production seam
    (the actual orchestrator, runner, or integration point where the behavior
    lives). A test that copies the logic it claims to verify, or asserts only
    against a test-local mock of the code under test, is false coverage — flag it.

(b) RED-verification note check. For every CONSTRAINT-GUARDING test — one that
    pins an architectural constraint or asserts parity between two code paths —
    confirm it carries a RED-verification note proving it was seen to FAIL
    against the pre-change code. A constraint-guarding test with no evidence it
    was proven to fail pre-change is inadequate coverage — flag it. Do NOT demand
    a RED-verification note on ordinary happy-path tests; this requirement is
    scoped to constraint-guarding tests only.

Bias toward the FALSE-NEGATIVE. When work is suspicious-but-plausible, REJECT it
rather than accept it. An agent can self-reflect on a falsely-failing test, but it
cannot recover from a falsely-passing one — a wrongly-blocked-but-real test is
cheap, a silently-accepted reimplementation is not.

On detecting either failure (a test-local reimplementation, or a missing
RED-verification note on a constraint-guarding test): FLAG and FAIL the review,
and SURFACE the finding explicitly in your reported result. Never pass silently on
a detected reimplementation or a missing RED note — a dropped finding is the exact
false-green failure this gate exists to prevent.
--- End Adversarial Verifier Review Gate ---`;
}

/**
 * Mutation-check gate instruction (review-gate-mutation-check, Sprint 17).
 * Extends the review gate from "reason about coverage" to "produce mechanical RED
 * evidence of coverage": the verifier must break the primary production seam and
 * prove the suite notices. Composed AFTER buildAdversarialGateSection by
 * buildStep7GateInstruction — strictly additive, never a replacement.
 *
 * Content contract (pinned by the AC 1-5/8 tests):
 *  - Perform a mutation test on the primary production seam(s) the feature owns.
 *  - Decision rule: a mutation that FAILs ≥1 feature-scoped test (RED) confirms
 *    coverage; a suite that stays GREEN under the mutation is a false-green → FAIL.
 *  - Restore-and-verify: revert the mutation and re-confirm green before finishing.
 *  - Emit a structured evidence block (SEAM / MUTATION / RED EVIDENCE / RESTORED).
 *  - Per-independent-seam guidance (not a countable rule); no-executable-seam skip.
 */
export function buildMutationCheckSection(): string {
  return `--- Mutation-Check Evidence Requirement ---
Reasoning about coverage is not enough — a verifier can be wrong about whether a
test exercises the real code, but a MUTATION cannot lie: if breaking the production
code does not break a test, the coverage is false. You MUST produce mechanical
mutation evidence for this review.

Do this:

(1) Identify the PRIMARY PRODUCTION SEAM(S) this feature introduces or changes — the
    actual function/wiring where the new behavior lives (not a test, not a type).
    If the feature adds more than one INDEPENDENT SEAM (for example two separate
    call sites, or a helper plus its wiring), mutate EACH independent seam — breaking
    only one may leave the other's tests green, which is exactly the gap this check
    exists to catch. This is guidance, not a fixed count: a feature with a single
    seam needs a single mutation.

(2) MUTATE the seam in the working copy: delete or no-op its body, or remove the
    wiring call. Then run the feature-scoped tests.

(3) DECISION RULE — apply it explicitly:
    • If the mutation makes AT LEAST ONE feature-scoped test FAIL (RED) — including a
      compile/typecheck failure caused by the mutation — coverage of that seam is
      CONFIRMED. Proceed.
    • If the suite stays GREEN under the mutation, that is a FALSE-GREEN: no test
      covers that seam. FLAG and FAIL the review, naming the uncovered seam.

(4) RESTORE and verify: revert the mutation and re-confirm the suite is GREEN before
    completing. NEVER leave mutated production code behind.

(5) SURFACE the evidence in your reported result as this block, one per seam:
    MUTATION CHECK
    SEAM: <file:symbol the feature owns>
    MUTATION: <how it was broken — deleted body / removed wiring call / no-op>
    RED EVIDENCE: <failing test name(s) or the compile/typecheck error the mutation caused>
    RESTORED: <confirmation the code was reverted and the suite is green again>

If this feature's deliverable is NOT executable production code (a docs-only or
config-only change with NO EXECUTABLE PRODUCTION SEAM to break), record
"SEAM: none (no executable production seam)" and skip the mutation — do not fabricate
one. If you CANNOT obtain the evidence (the mutation can't be run), FLAG and FAIL —
an inability to produce evidence is not a pass.
--- End Mutation-Check Evidence Requirement ---`;
}

/**
 * The full step-7 review-gate instruction the runner injects at BOTH the
 * single-feature and multi-feature QA seams. Single source of truth so the two
 * seams cannot drift (review-gate-mutation-check AC 7): the Sprint-14 adversarial
 * section composed with the Sprint-17 mutation-check section.
 */
export function buildStep7GateInstruction(): string {
  return `${buildAdversarialGateSection()}\n\n${buildMutationCheckSection()}`;
}

export function buildRolePrompt(role: Role, dinoNames?: Record<Role, DinoIdentity>): string {
  const names = dinoNames || resolveDinoNames();
  const preamble = buildDinoIdentityPreamble(role, names);
  return `${preamble}\n\n${ROLE_PROMPTS[role]}`;
}

/**
 * Read and inject TEAM.md from the project directory.
 * Falls back to bundled template if project doesn't have one.
 * Caps output at TEAM_MD_MAX_SIZE to avoid context bloat.
 */
export function buildTeamMdContext(projectPath: string): string {
  const projectTeamMd = path.join(projectPath, "TEAM.md");
  let content: string | null = null;

  if (fs.existsSync(projectTeamMd)) {
    try {
      content = fs.readFileSync(projectTeamMd, "utf-8");
    } catch {
      // Fall through to bundled template
    }
  }

  // Fallback: try bundled template
  if (!content) {
    try {
      const bundledPath = path.join(__dirname, "..", "..", "template", "TEAM.md");
      if (fs.existsSync(bundledPath)) {
        content = fs.readFileSync(bundledPath, "utf-8");
      }
    } catch {
      // No TEAM.md available
    }
  }

  if (!content) return "";

  const truncated = content.slice(0, TEAM_MD_MAX_SIZE);
  const suffix = content.length > TEAM_MD_MAX_SIZE ? "\n\n[... truncated for context size ...]" : "";

  return `--- TEAM.md (Process Definition) ---\n${truncated}${suffix}\n--- End TEAM.md ---`;
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
    // Route through the same matcher used for output validation (single
    // matching implementation — see glob-match.ts). Slug-scoped patterns
    // inject exactly the feature's own artifacts instead of guessing a
    // literal path and then dumping the whole directory.
    const { matchedFiles } = matchExpectedOutput(pattern, projectPath, featureSlug);

    if (matchedFiles.length > 0) {
      if (classifyPattern(pattern) === "double-star") {
        // Broad code patterns (e.g. src/**/*.ts) can match the entire tree —
        // inject a file listing, not contents, to keep context bounded.
        sections.push(
          `--- ${pattern} (matched files) ---\n${matchedFiles.join("\n")}`
        );
      } else {
        for (const rel of matchedFiles) {
          try {
            const content = fs.readFileSync(path.join(projectPath, rel), "utf-8");
            sections.push(`--- ${rel} ---\n${content}`);
          } catch {
            // Skip unreadable files
          }
        }
      }
      continue;
    }

    // Fallback (pre-existing behavior): no slug-scoped match — read every
    // file in the pattern's directory so unconventionally-named artifacts
    // still reach the agent.
    const resolvedPattern = pattern.replace("*", featureSlug);
    const dir = path.dirname(path.join(projectPath, resolvedPattern));
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

  if (sections.length === 0) {
    return "No input artifacts found for this step.";
  }

  return sections.join("\n\n");
}
