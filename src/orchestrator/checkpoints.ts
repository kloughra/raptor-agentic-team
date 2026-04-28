import { CheckpointType, Role } from "./workflow";
import { DinoIdentity, resolveDinoNames, formatHandoffRole } from "./dino";

export interface CheckpointPrompt {
  type: CheckpointType;
  title: string;
  context: string;
  options: string[];
  feedbackLabel: string;
  /**
   * Multi-feature mode only: identifies which feature this checkpoint pertains to.
   * Single-feature mode leaves this undefined.
   */
  feature?: string;
}

const CHECKPOINT_CONFIG: Record<
  CheckpointType,
  { title: string; nextAction: string; feedbackLabel: string; triggeredBy: Role }
> = {
  "spec-review": {
    title: "Spec Review",
    nextAction: "proceed to architecture design",
    feedbackLabel: "Feedback for the PO (optional):",
    triggeredBy: "po",
  },
  "tech-approval": {
    title: "Technology Approval",
    nextAction: "proceed to QA test authoring",
    feedbackLabel: "Feedback for the Architect (optional):",
    triggeredBy: "architect",
  },
  "pr-review": {
    title: "PR Review",
    nextAction: "proceed to QA test execution",
    feedbackLabel: "Review comments for the Engineer (optional):",
    triggeredBy: "engineer",
  },
  "demo-feedback": {
    title: "Demo Feedback",
    nextAction: "merge the PR and proceed to retrospective",
    feedbackLabel: "Feedback on the demo (optional):",
    triggeredBy: "team",
  },
  "retro-review": {
    title: "Retrospective Review",
    nextAction: "apply selected improvements and complete the sprint",
    feedbackLabel: "Enter proposal numbers to adopt (e.g., '1,3'), 'all' to adopt all, or 'skip' to skip:",
    triggeredBy: "team",
  },
};

export function buildCheckpointPrompt(
  type: CheckpointType,
  artifactSummary: string,
  dinoNames?: Record<Role, DinoIdentity>,
  featureSlug?: string
): CheckpointPrompt {
  const config = CHECKPOINT_CONFIG[type];
  const names = dinoNames || resolveDinoNames();
  const roleName = formatHandoffRole(config.triggeredBy, names);

  const baseContext = [
    `**${roleName}** is requesting your review.`,
    "",
    artifactSummary,
    "",
    "**What would you like to do?**",
    `- **Approve** — ${config.nextAction}`,
    "- **Request changes** — provide feedback to revise",
    "",
    config.feedbackLabel,
  ].join("\n");

  // Multi-feature mode: annotate the title with the feature slug and prefix the
  // context with a feature header so the user always knows which feature this
  // checkpoint is for (architecture §5, AC #13).
  const title = featureSlug ? `${config.title} — ${featureSlug}` : config.title;
  const context = featureSlug
    ? `**Feature:** ${featureSlug}\n\n${baseContext}`
    : baseContext;

  const result: CheckpointPrompt = {
    type,
    title,
    context,
    options: ["approve", "request-changes"],
    feedbackLabel: config.feedbackLabel,
  };

  if (featureSlug) {
    result.feature = featureSlug;
  }

  return result;
}
