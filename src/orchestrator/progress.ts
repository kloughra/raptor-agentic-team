import { SprintState } from "./state";
import { MAX_RETRY_ATTEMPTS } from "./runner";

const STATUS_ICONS: Record<string, string> = {
  complete: "✅",
  "in-progress": "🔄",
  pending: "⬜",
  failed: "❌",
  escalated: "🚨",
};

export function renderProgressTable(state: SprintState): string {
  const lines: string[] = [];

  lines.push(`## 🦖 Sprint ${state.sprint} — ${state.project}`);
  lines.push("");
  lines.push("| Step | Role | Task | Status |");
  lines.push("|------|------|------|--------|");

  for (const step of state.steps) {
    let statusDisplay: string;

    if (step.status === "escalated") {
      statusDisplay = `🚨 escalated (${step.attempts}/${MAX_RETRY_ATTEMPTS})`;
    } else if (step.status === "in-progress" && step.attempts > 1) {
      statusDisplay = `⚠ attempt ${step.attempts}/${MAX_RETRY_ATTEMPTS}`;
    } else {
      statusDisplay = STATUS_ICONS[step.status] || "⬜";
    }

    lines.push(
      `| ${step.step} | ${capitalizeRole(step.role)} | ${step.name} | ${statusDisplay} |`
    );
  }

  // Add checkpoint info if paused
  if (state.status === "paused") {
    const pendingCheckpoint = state.checkpoints.find(
      (c) => c.status === "pending"
    );
    if (pendingCheckpoint) {
      lines.push("");
      lines.push(`**Paused at checkpoint: ${pendingCheckpoint.type}** — awaiting user input`);
    }
  }

  if (state.status === "escalated") {
    lines.push("");
    lines.push("**Sprint escalated** 🚨 — awaiting user intervention");
  }

  if (state.status === "complete") {
    lines.push("");
    lines.push("**Sprint complete** ✅");
  }

  // DoD checklist summary
  if (state.dod) {
    const dodItems = [
      { label: "Tests pass", value: state.dod.testsPass },
      { label: "Code committed", value: state.dod.codeCommitted },
      { label: "Peer review approved", value: state.dod.prReviewApproved },
      { label: "PO accepted", value: state.dod.poAccepted },
      { label: "Demo completed", value: state.dod.demoCompleted },
    ];
    const allSatisfied = dodItems.every((i) => i.value);
    lines.push("");
    lines.push(`### Definition of Done ${allSatisfied ? "✅" : "🔄"}`);
    for (const item of dodItems) {
      lines.push(`- [${item.value ? "x" : " "}] ${item.label}`);
    }
  }

  return lines.join("\n");
}

function capitalizeRole(role: string): string {
  const map: Record<string, string> = {
    po: "PO",
    architect: "Architect",
    qa: "QA",
    engineer: "Engineer",
    team: "Team",
  };
  return map[role] || role;
}
