/**
 * Unit tests — notification-egress notifier (Sprint 16)
 *
 * Colocated unit coverage for the PURE derivers + the dispatch choke point:
 *   • deriveNotificationEvent — status→event mapping, null for non-notifiable,
 *     state-only payload (never agent stdout), dedup event-key scheme.
 *   • buildResumeCommand — actionable-only, 1:1 with resumeSprintTool args.
 *   • emitNotification — dedup marker, per-driver isolation, off-switch parity,
 *     never-throws.
 *
 * The production-seam (real runner → persisted reload → emit) coverage lives in
 * tests/integration/notification-egress.integration.test.ts (TEAM.md QA rule 12).
 * These unit tests exercise the pure logic directly.
 */

import { describe, it, expect } from "@jest/globals";
import {
  NotificationEvent,
  deriveNotificationEvent,
  buildResumeCommand,
  emitNotification,
} from "./notifications";
import { NotificationDriver } from "./notification-driver";
import { createInitialState, SprintState } from "./state";
import { SPRINT_WORKFLOW } from "./workflow";
import { featureBranchName } from "./multi-runner";

const SPRINT = 16;
const PROJECT = "myapp";
const SLUG = "notification-egress";
const OCCURRED_AT = "2026-07-12T18:04:00.000Z";
const OPTS = { projectSlug: SLUG, occurredAt: OCCURRED_AT };

function workflowSteps() {
  return SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name }));
}

function baseState(overrides: Partial<SprintState> = {}): SprintState {
  const state = createInitialState(
    PROJECT,
    SPRINT,
    workflowSteps(),
    featureBranchName(SPRINT, SLUG)
  );
  state.notifiedEvents = [];
  return { ...state, ...overrides };
}

function checkpointState(): SprintState {
  const s = baseState({ status: "paused", currentStep: 6 });
  s.checkpoints = [
    { type: "pr-review", status: "pending", feedback: null, resolvedAt: null, feature: null },
  ];
  return s;
}

function escalatedState(): SprintState {
  const s = baseState({ status: "escalated", currentStep: 7 });
  const step7 = s.steps.find((st) => st.step === 7)!;
  step7.status = "escalated";
  step7.escalationReason = "attempts-exhausted";
  return s;
}

class CapturingDriver implements NotificationDriver {
  readonly name = "capture";
  readonly events: NotificationEvent[] = [];
  send(event: NotificationEvent): void {
    this.events.push(event);
  }
}

describe("deriveNotificationEvent — status → event kind", () => {
  it("paused → checkpoint", () => {
    const e = deriveNotificationEvent(checkpointState(), OPTS);
    expect(e?.event).toBe("checkpoint");
    expect(e?.status).toBe("paused");
  });

  it("escalated → escalation", () => {
    const e = deriveNotificationEvent(escalatedState(), OPTS);
    expect(e?.event).toBe("escalation");
    expect(e?.status).toBe("escalated");
  });

  it("complete → complete", () => {
    const e = deriveNotificationEvent(baseState({ status: "complete" }), OPTS);
    expect(e?.event).toBe("complete");
  });

  it("failed → failed", () => {
    const e = deriveNotificationEvent(baseState({ status: "failed" }), OPTS);
    expect(e?.event).toBe("failed");
  });

  it("in-progress → null (not notifiable)", () => {
    expect(deriveNotificationEvent(baseState({ status: "in-progress" }), OPTS)).toBeNull();
  });
});

describe("deriveNotificationEvent — payload derived only from persisted state", () => {
  it("project and sprint come from state", () => {
    const e = deriveNotificationEvent(baseState({ status: "complete" }), OPTS)!;
    expect(e.project).toBe(PROJECT);
    expect(e.sprint).toBe(SPRINT);
    expect(e.occurredAt).toBe(OCCURRED_AT);
  });

  it("single-feature slug is parsed from the branch name", () => {
    const e = deriveNotificationEvent(baseState({ status: "complete" }), OPTS)!;
    expect(e.feature).toBe(SLUG);
  });

  it("the envelope carries exactly the nine declared keys — no leaked field", () => {
    const state = escalatedState();
    (state as SprintState & { agentReport?: string }).agentReport = "secret all green";
    const e = deriveNotificationEvent(state, OPTS)!;
    expect(new Set(Object.keys(e))).toEqual(
      new Set([
        "event",
        "project",
        "sprint",
        "status",
        "feature",
        "reason",
        "resumeCommand",
        "eventKey",
        "occurredAt",
      ])
    );
    expect(JSON.stringify(e)).not.toContain("secret");
  });
});

describe("event-key scheme (dedup identity)", () => {
  it("checkpoint key encodes sprint, index, and type", () => {
    const e = deriveNotificationEvent(checkpointState(), OPTS)!;
    expect(e.eventKey).toBe(`checkpoint:${SPRINT}:sprint:idx0:pr-review`);
  });

  it("a distinct new checkpoint produces a distinct key", () => {
    const s = checkpointState();
    s.checkpoints[0].status = "approved";
    s.checkpoints.push({
      type: "demo-feedback",
      status: "pending",
      feedback: null,
      resolvedAt: null,
      feature: null,
    });
    const e = deriveNotificationEvent(s, OPTS)!;
    expect(e.eventKey).toBe(`checkpoint:${SPRINT}:sprint:idx1:demo-feedback`);
  });

  it("terminal keys are singletons", () => {
    expect(deriveNotificationEvent(baseState({ status: "complete" }), OPTS)!.eventKey).toBe(
      `complete:${SPRINT}:sprint:-`
    );
    expect(deriveNotificationEvent(baseState({ status: "failed" }), OPTS)!.eventKey).toBe(
      `failed:${SPRINT}:sprint:-`
    );
  });
});

describe("buildResumeCommand", () => {
  it("checkpoint → copy-pasteable resume_sprint with name/sprint/action", () => {
    const state = checkpointState();
    const event = deriveNotificationEvent(state, OPTS)!;
    const cmd = buildResumeCommand(state, event)!;
    expect(cmd).toContain("resume_sprint");
    expect(cmd).toContain(`name="${PROJECT}"`);
    expect(cmd).toContain(`sprint=${SPRINT}`);
    expect(cmd).toContain(`action="approve"`);
  });

  it("terminal complete → null", () => {
    const state = baseState({ status: "complete" });
    const event = deriveNotificationEvent(state, OPTS)!;
    expect(buildResumeCommand(state, event)).toBeNull();
  });

  it("multi-feature escalation names the escalated feature slug", () => {
    const s = baseState({ status: "escalated", currentStep: 7 });
    s.currentFeatureSlug = SLUG;
    s.features = [
      {
        slug: "other",
        branchName: `sprint-${SPRINT}/other`,
        status: "complete",
        currentStep: 9,
        steps: [],
        dod: { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: true, demoCompleted: true },
      },
      {
        slug: SLUG,
        branchName: featureBranchName(SPRINT, SLUG),
        status: "escalated",
        currentStep: 7,
        steps: [],
        dod: { codeCommitted: false, testsPass: false, prReviewApproved: false, poAccepted: false, demoCompleted: false },
      },
    ];
    const event = deriveNotificationEvent(s, OPTS)!;
    expect(event.feature).toBe(SLUG);
    expect(buildResumeCommand(s, event)).toContain(`feature="${SLUG}"`);
  });
});

describe("emitNotification — dispatch, dedup, isolation, parity", () => {
  it("sends exactly once and records the dedup marker on success", async () => {
    const state = checkpointState();
    const driver = new CapturingDriver();
    let saved = 0;
    await emitNotification(state, [driver], { ...OPTS, save: () => { saved++; } });
    expect(driver.events).toHaveLength(1);
    expect(saved).toBe(1);
    expect(state.notifiedEvents).toContain(driver.events[0].eventKey);
  });

  it("re-dispatch against the same state fires no duplicate", async () => {
    const state = checkpointState();
    const driver = new CapturingDriver();
    await emitNotification(state, [driver], { ...OPTS, save: () => {} });
    await emitNotification(state, [driver], { ...OPTS, save: () => {} });
    expect(driver.events).toHaveLength(1);
  });

  it("zero drivers → no dispatch, no state mutation, no save (off-switch parity)", async () => {
    const state = baseState({ status: "complete" });
    const before = JSON.stringify(state.notifiedEvents);
    let saved = false;
    await emitNotification(state, [], { ...OPTS, save: () => { saved = true; } });
    expect(saved).toBe(false);
    expect(JSON.stringify(state.notifiedEvents)).toBe(before);
  });

  it("a throwing driver never rejects and never marks the event notified", async () => {
    const bad: NotificationDriver = {
      name: "bad",
      send() {
        throw new Error("boom");
      },
    };
    const state = baseState({ status: "failed" });
    await expect(
      emitNotification(state, [bad], { ...OPTS, save: () => {} })
    ).resolves.toBeUndefined();
    expect(state.notifiedEvents).toHaveLength(0);
  });

  it("a good driver still sends when a sibling throws (per-driver isolation)", async () => {
    const good = new CapturingDriver();
    const bad: NotificationDriver = {
      name: "bad",
      send() {
        throw new Error("boom");
      },
    };
    await emitNotification(baseState({ status: "complete" }), [bad, good], {
      ...OPTS,
      save: () => {},
    });
    expect(good.events).toHaveLength(1);
  });

  it("in-progress state dispatches nothing", async () => {
    const driver = new CapturingDriver();
    await emitNotification(baseState({ status: "in-progress" }), [driver], {
      ...OPTS,
      save: () => {},
    });
    expect(driver.events).toHaveLength(0);
  });
});
