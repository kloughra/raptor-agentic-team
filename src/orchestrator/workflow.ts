export type Role = "po" | "architect" | "qa" | "engineer" | "team";

export type CheckpointType =
  | "spec-review"
  | "tech-approval"
  | "pr-review"
  | "demo-feedback"
  | "retro-review";

export type StepStatus = "pending" | "in-progress" | "complete" | "failed" | "escalated";

export interface WorkflowStep {
  step: number;
  role: Role;
  name: string;
  description: string;
  checkpointAfter?: CheckpointType;
  inputArtifacts: string[];
  expectedOutputs: string[];
}

/**
 * The sprint workflow steps, mapping directly to TEAM.md Sprint Workflow steps 1–9.
 * Input/output patterns use globs resolved against the project root.
 * The {slug} placeholder is replaced at runtime with the feature slug.
 */
export const SPRINT_WORKFLOW: WorkflowStep[] = [
  {
    step: 1,
    role: "po",
    name: "Author specification",
    description:
      "Read the backlog item and author a feature specification with acceptance criteria",
    checkpointAfter: "spec-review",
    inputArtifacts: ["docs/backlog.md"],
    expectedOutputs: ["docs/specs/*.md"],
  },
  {
    step: 2,
    role: "architect",
    name: "Architecture design",
    description:
      "Read the spec and produce an architecture design document with NFRs; present technology choices for user approval",
    checkpointAfter: "tech-approval",
    inputArtifacts: ["docs/specs/*.md"],
    expectedOutputs: ["docs/architecture/*.md"],
  },
  {
    step: 3,
    role: "qa",
    name: "Write tests",
    description:
      "Read the spec and architecture, then write BDD scenarios and integration tests",
    inputArtifacts: ["docs/specs/*.md", "docs/architecture/*.md"],
    expectedOutputs: ["tests/bdd/*.feature", "tests/integration/*"],
  },
  {
    step: 4,
    role: "po",
    name: "Review tests",
    description:
      "Review QA test cases against acceptance criteria and approve or request changes",
    inputArtifacts: [
      "docs/specs/*.md",
      "tests/bdd/*.feature",
      "tests/integration/*",
    ],
    expectedOutputs: [],
  },
  {
    step: 5,
    role: "engineer",
    name: "Implement (TDD)",
    description:
      "Read all artifacts, write unit tests first, then implement to make all tests pass",
    inputArtifacts: [
      "docs/specs/*.md",
      "docs/architecture/*.md",
      "tests/bdd/*.feature",
      "tests/integration/*",
    ],
    expectedOutputs: ["src/**/*.ts"],
  },
  {
    step: 6,
    role: "engineer",
    name: "Open PR",
    description:
      "Commit all code, push to feature branch, and open a PR with test results and linked spec",
    checkpointAfter: "pr-review",
    inputArtifacts: [],
    expectedOutputs: [],
  },
  {
    step: 7,
    role: "qa",
    name: "Run test suite",
    description: "Execute the full test suite and report results",
    inputArtifacts: ["src/**/*.ts", "tests/**/*"],
    expectedOutputs: [],
  },
  {
    step: 8,
    role: "team",
    name: "Demo",
    description:
      "Present the sprint increment to the user — demonstrate features and run tests live",
    checkpointAfter: "demo-feedback",
    inputArtifacts: [],
    expectedOutputs: [],
  },
  {
    step: 9,
    role: "engineer",
    name: "Merge PR",
    description:
      "Squash-merge the sprint PR after all approvals are in",
    inputArtifacts: [],
    expectedOutputs: [],
  },
  {
    step: 10,
    role: "po",
    name: "Process feedback",
    description:
      "Collect user feedback from the demo, triage it, and update the backlog",
    inputArtifacts: ["docs/backlog.md"],
    expectedOutputs: ["docs/backlog.md"],
  },
  {
    step: 11,
    role: "team",
    name: "Collect retro proposals",
    description:
      "Each role proposes one TEAM.md improvement based on their sprint experience",
    inputArtifacts: ["TEAM.md"],
    expectedOutputs: ["docs/sprints/*.md"],
  },
  {
    step: 12,
    role: "team",
    name: "Review retro proposals",
    description:
      "User reviews all proposals and selects which improvements to adopt",
    checkpointAfter: "retro-review",
    inputArtifacts: ["docs/sprints/*.md"],
    expectedOutputs: [],
  },
  {
    step: 13,
    role: "po",
    name: "Apply retro improvements",
    description:
      "Apply selected TEAM.md improvements and finalize the sprint",
    inputArtifacts: ["TEAM.md", "docs/sprints/*.md"],
    expectedOutputs: ["TEAM.md"],
  },
];

/**
 * Handoff mapping: after a step completes, who hands off to whom.
 */
export const HANDOFF_MAP: Record<number, { from: Role; to: Role; artifact: string }> = {
  1: { from: "po", to: "architect", artifact: "specification" },
  2: { from: "architect", to: "qa", artifact: "architecture design" },
  3: { from: "qa", to: "po", artifact: "test cases" },
  4: { from: "po", to: "engineer", artifact: "approved test cases" },
  5: { from: "engineer", to: "engineer", artifact: "implementation" },
  6: { from: "engineer", to: "qa", artifact: "PR for review" },
  7: { from: "qa", to: "team", artifact: "test results" },
  8: { from: "team", to: "engineer", artifact: "demo approval" },
  9: { from: "engineer", to: "po", artifact: "merged PR" },
  10: { from: "po", to: "team", artifact: "feedback processed" },
  11: { from: "team", to: "team", artifact: "retro proposals" },
  12: { from: "team", to: "po", artifact: "retro selections" },
};
