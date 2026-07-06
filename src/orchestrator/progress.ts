import { SprintState, FeatureState, StepState } from "./state";
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

/**
 * Status display for one step row, shared by the top-level and per-feature
 * loops (AC 22 — every circuit-breaker decision path is visible in reporting):
 * - complete via salvage        → "✅ complete (salvaged)"
 * - escalated, no-progress      → "🚨 escalated (no progress)"
 * - escalated, transient-cap    → "🚨 escalated (transient cap)"
 * - escalated, legacy/exhausted → today's "🚨 escalated (N/3)" display
 */
function stepStatusDisplay(step: StepState): string {
  if (step.status === "complete" && step.completedVia === "salvage") {
    return "✅ complete (salvaged)";
  }
  if (step.status === "escalated") {
    if (step.escalationReason === "no-progress") {
      return "🚨 escalated (no progress)";
    }
    if (step.escalationReason === "transient-cap") {
      return "🚨 escalated (transient cap)";
    }
    return `🚨 escalated (${step.attempts}/${MAX_RETRY_ATTEMPTS})`;
  }
  if (step.status === "in-progress" && step.attempts > 1) {
    return `⚠ attempt ${step.attempts}/${MAX_RETRY_ATTEMPTS}`;
  }
  return STATUS_ICONS[step.status] || "⬜";
}

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
    let statusDisplay = stepStatusDisplay(step);

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

    // AC #11: name which feature(s) escalated and at which step, and state the
    // exact resume command. In single-feature mode there are no feature rows;
    // surface the generic resume command instead.
    const escalatedFeatures = (state.features ?? []).filter(
      (f) => f.status === "escalated"
    );
    if (escalatedFeatures.length > 0) {
      for (const f of escalatedFeatures) {
        const escStep = f.steps.find((s) => s.status === "escalated");
        const stepDesc = escStep
          ? `step ${escStep.step} (${escStep.name})`
          : "an earlier step";
        lines.push(`- Feature **${f.slug}** escalated at ${stepDesc}`);
      }
      const slugHint =
        escalatedFeatures.length > 1 ? "--feature=<slug>" : "[--feature=<slug>]";
      lines.push(
        `Run \`resume_sprint --action=request-changes --feedback="…" ${slugHint}\` to re-engage. Completed sibling features are preserved.`
      );
    } else {
      lines.push(
        'Run `resume_sprint --action=request-changes --feedback="…"` to re-engage.'
      );
    }
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
        const statusDisplay = stepStatusDisplay(step);
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
