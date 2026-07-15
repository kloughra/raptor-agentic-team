/**
 * notification-egress (Sprint 16) — the notifier.
 *
 * Spec:         docs/specs/notification-egress.md (AC 1–12)
 * Architecture: docs/architecture/notification-egress.md (v2 REDESIGN)
 *
 * The heart of the feature: pure payload derivation + dedup + best-effort dispatch.
 * The payload is derived EXCLUSIVELY from persisted `SprintState` (never agent
 * stdout — AC #2), the pure derivers carry no clock (`occurredAt` is stamped by
 * `emitNotification`), and the whole dispatch path is exception-proof so a
 * notification failure can never break the sprint (AC #9).
 *
 * Emission seam: `emitNotification` is invoked at the TOOL boundary (`tools.ts`)
 * after the runner returns and the freshly-persisted state is reloaded from disk.
 * Exactly one notifiable event exists per `run_sprint`/`resume_sprint` invocation
 * (each runner call early-returns on the first terminal/park transition), so a
 * single dispatch at the boundary sees one event and reads persisted state —
 * structurally guaranteeing AC #2.
 */

import type { SprintState, FeatureState } from "./state";
import type { NotificationDriver } from "./notification-driver";
import { deriveSprintStatus } from "./multi-runner";

/**
 * The JSONL line schema — the Raptor↔watcher contract. Contains ONLY
 * state-derived fields: no secret, no webhook URL, no agent stdout (AC #10).
 */
export interface NotificationEvent {
  event: "checkpoint" | "escalation" | "complete" | "failed";
  project: string;
  sprint: number;
  status: SprintState["status"];
  feature: string | null;
  reason: string | null;
  resumeCommand: string | null;
  eventKey: string;
  occurredAt: string | null;
}

export interface DeriveOptions {
  /** The project's registry slug (used for `occurredAt` context only; not the feature). */
  projectSlug: string;
  /** Injected timestamp — no clock inside the pure derivers. */
  occurredAt: string;
}

export interface EmitOptions extends DeriveOptions {
  /** Persist the mutated state (dedup marker). Defaults to a no-op if omitted. */
  save?: (state: SprintState) => void;
}

/** Map a notifiable sprint status to its notification event kind. */
function eventKindForStatus(
  status: SprintState["status"]
): NotificationEvent["event"] | null {
  switch (status) {
    case "paused":
      return "checkpoint";
    case "escalated":
      return "escalation";
    case "complete":
      return "complete";
    case "failed":
      return "failed";
    default:
      return null; // in-progress and anything else is not notifiable
  }
}

function isMultiFeature(state: SprintState): boolean {
  return Array.isArray(state.features) && state.features.length > 0;
}

/**
 * The notifiable status. For multi-feature sprints in a terminal-ish state we defer
 * to the persisted derived status (`deriveSprintStatus`, Sprint 13) so a mixed
 * terminal state reflects the sprint, not one feature's self-report. `paused` is
 * always taken verbatim (the derive reducer has no `paused` state).
 */
function notifiableStatus(state: SprintState): SprintState["status"] {
  if (state.status === "paused") return "paused";
  if (isMultiFeature(state)) {
    return deriveSprintStatus(state.features as FeatureState[]);
  }
  return state.status;
}

/**
 * The actionable/derived feature slug for the event.
 * - Multi-feature: the feature the user must act on (escalated feature, else the
 *   newest pending checkpoint's feature, else `currentFeatureSlug`, else first).
 * - Single-feature: parsed from the branch name (`sprint-{N}/{slug}`) or
 *   `currentFeatureSlug`.
 */
function resolveFeatureSlug(state: SprintState): string | null {
  if (isMultiFeature(state)) {
    const features = state.features as FeatureState[];
    const escalated = features.find((f) => f.status === "escalated");
    if (escalated) return escalated.slug;
    const newestPending = [...state.checkpoints]
      .reverse()
      .find((c) => c.status === "pending" && c.feature);
    if (newestPending?.feature) return newestPending.feature;
    if (state.currentFeatureSlug) return state.currentFeatureSlug;
    return features[0]?.slug ?? null;
  }
  if (state.currentFeatureSlug) return state.currentFeatureSlug;
  if (state.branchName) {
    const m = state.branchName.match(/^sprint-\d+\/(.+)$/);
    if (m) return m[1];
  }
  return null;
}

/** The newest checkpoint entry (used for checkpoint reason + dedup identity). */
function newestCheckpoint(state: SprintState) {
  if (!state.checkpoints || state.checkpoints.length === 0) return null;
  return state.checkpoints[state.checkpoints.length - 1];
}

/** The escalated step (used for escalation reason + dedup identity). */
function escalatedStep(state: SprintState) {
  return state.steps.find((s) => s.status === "escalated") ?? null;
}

/** Human-readable reason string, derived from state — never agent text. */
function deriveReason(
  state: SprintState,
  kind: NotificationEvent["event"]
): string | null {
  if (kind === "checkpoint") {
    const cp = newestCheckpoint(state);
    return cp ? cp.type : null;
  }
  if (kind === "escalation") {
    const step = escalatedStep(state);
    if (!step) return null;
    const base = `step ${step.step} (${step.escalationReason ?? "escalated"})`;
    // branch-protection-merge-lockout (Sprint 18, AC 6): when the escalation
    // carries a persisted actionable detail (the PR-naming lockout message),
    // append it so the out-of-band notification names the concrete human
    // action. Back-compatible: absent ⇒ the existing `step N (reason)` string.
    if (step.escalationDetail) return `${base}: ${step.escalationDetail}`;
    return base;
  }
  return null;
}

/**
 * Dedup identity for an event (AC #11). Re-computing against the same parked /
 * terminal state yields the same key ⇒ deduped; a genuinely new checkpoint pushes a
 * new `checkpoints[]` entry ⇒ new index ⇒ new key ⇒ notifies.
 */
function computeEventKey(
  state: SprintState,
  kind: NotificationEvent["event"]
): string {
  const featurePart = isMultiFeature(state)
    ? resolveFeatureSlug(state) ?? "sprint"
    : "sprint";
  const sprint = state.sprint;
  switch (kind) {
    case "checkpoint": {
      const idx = state.checkpoints.length - 1;
      const type = newestCheckpoint(state)?.type ?? "unknown";
      return `checkpoint:${sprint}:${featurePart}:idx${idx}:${type}`;
    }
    case "escalation": {
      const step = escalatedStep(state);
      const stepNum = step?.step ?? state.currentStep;
      const reason = step?.escalationReason ?? "escalated";
      return `escalation:${sprint}:${featurePart}:step${stepNum}:${reason}`;
    }
    case "complete":
      return `complete:${sprint}:sprint:-`;
    case "failed":
      return `failed:${sprint}:sprint:-`;
  }
}

/**
 * Reconstruct the exact copy-pasteable `resume_sprint` command for actionable
 * events (AC #3). Maps 1:1 to `resumeSprintTool`'s `{name, sprint, action,
 * feature?}` signature. Terminal (complete/failed) events → `null`.
 */
export function buildResumeCommand(
  state: SprintState,
  event: NotificationEvent
): string | null {
  if (event.event !== "checkpoint" && event.event !== "escalation") {
    return null;
  }
  const parts = [
    `name="${state.project}"`,
    `sprint=${state.sprint}`,
    `action="approve"`,
  ];
  // The actionable feature is named only in multi-feature mode so the user's
  // command targets the correct feature (mixed-terminal edge case).
  if (isMultiFeature(state) && event.feature) {
    parts.push(`feature="${event.feature}"`);
  }
  return `resume_sprint(${parts.join(", ")})`;
}

/**
 * Derive a `NotificationEvent` EXCLUSIVELY from persisted state. Pure — no I/O, no
 * clock (except the injected `occurredAt`). Returns `null` for a non-notifiable
 * (e.g. `in-progress`) status.
 */
export function deriveNotificationEvent(
  state: SprintState,
  opts: DeriveOptions
): NotificationEvent | null {
  const status = notifiableStatus(state);
  const kind = eventKindForStatus(status);
  if (!kind) return null;

  const event: NotificationEvent = {
    event: kind,
    project: state.project,
    sprint: state.sprint,
    status,
    feature: resolveFeatureSlug(state),
    reason: deriveReason(state, kind),
    resumeCommand: null,
    eventKey: computeEventKey(state, kind),
    occurredAt: opts.occurredAt,
  };
  event.resumeCommand = buildResumeCommand(state, event);
  return event;
}

/**
 * The single dispatch choke point (AC #1, #11, #9). Derives the event from
 * persisted state, dedups against the `notifiedEvents` marker, sends best-effort
 * with per-driver isolation, and records the marker only after a successful send.
 * NEVER throws — a notification failure can never break the sprint.
 */
export async function emitNotification(
  state: SprintState,
  drivers: NotificationDriver[],
  opts: EmitOptions
): Promise<void> {
  try {
    // Parity path: with no drivers there is zero I/O and zero state mutation
    // (AC #8 hard off-switch).
    if (!drivers || drivers.length === 0) return;

    const event = deriveNotificationEvent(state, opts);
    if (!event) return; // not notifiable

    const notified = state.notifiedEvents ?? [];
    if (notified.includes(event.eventKey)) return; // dedup (AC #11)

    let anySent = false;
    for (const driver of drivers) {
      try {
        await driver.send(event);
        anySent = true;
      } catch {
        // Best-effort, per-driver isolation (AC #9): a throwing driver never
        // aborts sibling drivers and never propagates.
      }
    }

    // Mark-after-success: a failed local write retries next invocation.
    if (anySent) {
      state.notifiedEvents = [...notified, event.eventKey];
      if (opts.save) opts.save(state);
    }
  } catch {
    // Exception-proof: nothing in the emission path escapes into the orchestrator.
  }
}
