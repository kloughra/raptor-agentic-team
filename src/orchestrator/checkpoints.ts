import { CheckpointType } from "./workflow";

export interface CheckpointPrompt {
  type: CheckpointType;
  title: string;
  context: string;
  options: string[];
  feedbackLabel: string;
}

const CHECKPOINT_CONFIG: Record<
  CheckpointType,
  { title: string; nextAction: string; feedbackLabel: string }
> = {
  "spec-review": {
    title: "Spec Review",
    nextAction: "proceed to architecture design",
    feedbackLabel: "Feedback for the PO (optional):",
  },
  "tech-approval": {
    title: "Technology Approval",
    nextAction: "proceed to QA test authoring",
    feedbackLabel: "Feedback for the Architect (optional):",
  },
  "pr-review": {
    title: "PR Review",
    nextAction: "proceed to QA test execution",
    feedbackLabel: "Review comments for the Engineer (optional):",
  },
  "demo-feedback": {
    title: "Demo Feedback",
    nextAction: "complete the sprint",
    feedbackLabel: "Feedback on the demo (optional):",
  },
};

export function buildCheckpointPrompt(
  type: CheckpointType,
  artifactSummary: string
): CheckpointPrompt {
  const config = CHECKPOINT_CONFIG[type];

  const context = [
    artifactSummary,
    "",
    "**What would you like to do?**",
    `- **Approve** — ${config.nextAction}`,
    "- **Request changes** — provide feedback to revise",
    "",
    config.feedbackLabel,
  ].join("\n");

  return {
    type,
    title: config.title,
    context,
    options: ["approve", "request-changes"],
    feedbackLabel: config.feedbackLabel,
  };
}
