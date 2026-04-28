import { SprintState, FeatureState } from "./state";
import { MAX_RETRY_ATTEMPTS } from "./runner";
import { Role } from "./workflow";
import { DinoIdentity, resolveDinoNames, formatRoleDisplay } from "./dino";

const STATUS_ICONS: Record<string, string> = {
  complete: "✅",
  "in-progress": "🔄",
  pending: "⬜",
  failed: "❌",
  escalated: "🚨",
};

export function renderProgressTable(
  state: SprintState,
  dinoNames?: Record<Role, DinoIdentity>
): string {
  const lines: string[] = [];
  const names = dinoNames || resolveDinoNames();

  lines.push(`## 🦖 Sprint ${state.sprint} — ${state.project}`);
  lines.push("");
  lines.push("| Step | Role | Task | Status |");
  lines.push("|------|------|------|--------|");

  // In multi-feature mode, top-level state.steps for steps 1–9 stays "pending"
  // for the lifetime of the sprint (per-feature subtables are the source of
  // truth). Annotate those rows so the user is not confused (AC #9).
  const isMultiFeatureMode = !!(state.features && state.features.length > 1);

  for (const step of state.steps) {
    let statusDisplay: string;

    if (step.status === "escalated") {
      statusDisplay = `🚨 escalated (${step.attempts}/${MAX_RETRY_ATTEMPTS})`;
    } else if (step.status === "in-progress" && step.attempts > 1) {
      statusDisplay = `⚠ attempt ${step.attempts}/${MAX_RETRY_ATTEMPTS}`;
    } else {
      statusDisplay = STATUS_ICONS[step.status] || "⬜";
    }

    if (isMultiFeatureMode && step.step <= 9) {
      statusDisplay = `${statusDisplay} (per-feature)`;
    }

    const roleDisplay = formatRoleDisplay(step.role as Role, names);

    lines.push(
      `| ${step.step} | ${roleDisplay} | ${step.name} | ${statusDisplay} |`
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

  // Multi-feature progress (if applicable)
  if (state.features && state.features.length > 0) {
    lines.push("");
    lines.push("### Per-Feature Progress");
    for (const feature of state.features) {
      lines.push("");
      lines.push(`#### Feature: ${feature.slug} — ${STATUS_ICONS[feature.status] || "⬜"}`);
      lines.push("| Step | Role | Task | Status |");
      lines.push("|------|------|------|--------|");
      for (const step of feature.steps) {
        let statusDisplay: string;
        if (step.status === "escalated") {
          statusDisplay = `🚨 escalated (${step.attempts}/${MAX_RETRY_ATTEMPTS})`;
        } else if (step.status === "in-progress" && step.attempts > 1) {
          statusDisplay = `⚠ attempt ${step.attempts}/${MAX_RETRY_ATTEMPTS}`;
        } else {
          statusDisplay = STATUS_ICONS[step.status] || "⬜";
        }
        const roleDisplay = formatRoleDisplay(step.role as Role, names);
        lines.push(`| ${step.step} | ${roleDisplay} | ${step.name} | ${statusDisplay} |`);
      }

      // Per-feature DoD
      if (feature.dod) {
        const dodItems = [
          { label: "Tests pass", value: feature.dod.testsPass },
          { label: "Code committed", value: feature.dod.codeCommitted },
          { label: "Peer review approved", value: feature.dod.prReviewApproved },
          { label: "PO accepted", value: feature.dod.poAccepted },
          { label: "Demo completed", value: feature.dod.demoCompleted },
        ];
        const allSatisfied = dodItems.every((i) => i.value);
        lines.push(`DoD: ${allSatisfied ? "✅" : "🔄"} ${dodItems.filter((i) => i.value).length}/${dodItems.length}`);
      }
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
