import { SprintState } from "./state";

const STATUS_ICONS: Record<string, string> = {
  complete: "✅",
  "in-progress": "🔄",
  pending: "⬜",
  failed: "❌",
};

export function renderProgressTable(state: SprintState): string {
  const lines: string[] = [];

  lines.push(`## 🦖 Sprint ${state.sprint} — ${state.project}`);
  lines.push("");
  lines.push("| Step | Role | Task | Status |");
  lines.push("|------|------|------|--------|");

  for (const step of state.steps) {
    const icon = STATUS_ICONS[step.status] || "⬜";
    lines.push(
      `| ${step.step} | ${capitalizeRole(step.role)} | ${step.name} | ${icon} |`
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

  if (state.status === "complete") {
    lines.push("");
    lines.push("**Sprint complete** ✅");
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
