/**
 * Unit tests for: sprint-completes-despite-failed-merge (Sprint 13)
 *
 * Spec:         docs/specs/sprint-completes-despite-failed-merge.md
 * Architecture: docs/architecture/sprint-completes-despite-failed-merge.md
 *
 * These unit tests exercise the new PURE, exported helpers that back the
 * C3 (single-feature finalization guard, AC #4) and C4 (multi-feature
 * shared-step gate, AC #6) truthfulness guards, without touching the
 * filesystem or spawning agents:
 *
 *   - findIncompleteSteps          — the C3 invariant predicate
 *   - buildFinalizationGuardMessage — the C3 trip message (NFR 6: names steps)
 *   - findNonTerminalFeatures      — the C4 invariant predicate
 *   - buildSharedStepGateMessage   — the C4 trip message (NFR 6: names features)
 *
 * IMPORTANT (AC #10 / TEAM.md QA rule 12): these unit tests are NOT the
 * acceptance gate for this feature. The constraint-guarding coverage — the
 * in-place retry control flow (C1/C2), escalation-at-cap, and both guards
 * wired through the REAL runner loop and dispatcher — lives in
 * tests/integration/sprint-completes-despite-failed-merge.integration.test.ts,
 * which drives the production seam. A unit test of an extracted helper alone
 * is inadequate (architecture constraint 8); these tests only pin the pure
 * predicate/message semantics the guards delegate to.
 *
 * File is named by feature slug (not `runner.test.ts`) so it runs under the
 * sprint's scoped test command:
 *   npx jest --testPathPattern="sprint-completes-despite-failed-merge"
 */

import { describe, it, expect } from "@jest/globals";
import {
  findIncompleteSteps,
  buildFinalizationGuardMessage,
  findNonTerminalFeatures,
  buildSharedStepGateMessage,
} from "./runner";
import { createFeatureStates } from "./multi-runner";
import { createInitialState, FeatureState, StepState } from "./state";
import { SPRINT_WORKFLOW, StepStatus } from "./workflow";

const SPRINT = 13;

function workflowSteps() {
  return SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name }));
}

/** Fresh full-workflow step list with every step forced to `status`. */
function stepsAll(status: StepStatus): StepState[] {
  const state = createInitialState("unit-test", SPRINT, workflowSteps(), null);
  for (const s of state.steps) s.status = status;
  return state.steps;
}

function setStep(steps: StepState[], stepNum: number, status: StepStatus): void {
  const s = steps.find((st) => st.step === stepNum)!;
  s.status = status;
}

// ===========================================================================
// C3 — findIncompleteSteps (AC #4 invariant predicate)
// ===========================================================================

describe("findIncompleteSteps (C3, AC #4)", () => {
  it("returns [] when every step is complete — the only state that may finalize as 'complete'", () => {
    expect(findIncompleteSteps(stepsAll("complete"))).toEqual([]);
  });

  it("flags a step left 'in-progress' (the Sprint 10/12 specimen shape: step 9 open)", () => {
    const steps = stepsAll("complete");
    setStep(steps, 9, "in-progress");

    const incomplete = findIncompleteSteps(steps);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0].step).toBe(9);
    expect(incomplete[0].status).toBe("in-progress");
  });

  it("flags every non-complete status: pending, in-progress, failed, escalated", () => {
    for (const status of ["pending", "in-progress", "failed", "escalated"] as StepStatus[]) {
      const steps = stepsAll("complete");
      setStep(steps, 9, status);
      expect(findIncompleteSteps(steps).map((s) => s.step)).toEqual([9]);
    }
  });

  it("flags multiple non-complete steps in workflow order", () => {
    const steps = stepsAll("complete");
    setStep(steps, 9, "in-progress");
    setStep(steps, 13, "pending");

    expect(findIncompleteSteps(steps).map((s) => s.step)).toEqual([9, 13]);
  });

  it("does not mutate the input steps (guards report, never repair — constraint 4)", () => {
    const steps = stepsAll("complete");
    setStep(steps, 9, "in-progress");
    const before = JSON.stringify(steps);

    findIncompleteSteps(steps);

    expect(JSON.stringify(steps)).toBe(before);
  });
});

// ===========================================================================
// C3 — buildFinalizationGuardMessage (NFR 6: names offending steps)
// ===========================================================================

describe("buildFinalizationGuardMessage (C3, AC #4)", () => {
  it("names each non-complete step by number, name, and status", () => {
    const steps = stepsAll("complete");
    setStep(steps, 9, "in-progress");
    const msg = buildFinalizationGuardMessage(findIncompleteSteps(steps));

    expect(msg).toContain("Sprint NOT complete");
    expect(msg).toContain("9 (Merge PR, in-progress)");
    expect(msg).toContain("resume_sprint");
  });

  it("lists all offending steps when more than one is non-complete", () => {
    const steps = stepsAll("complete");
    setStep(steps, 9, "escalated");
    setStep(steps, 13, "pending");
    const msg = buildFinalizationGuardMessage(findIncompleteSteps(steps));

    expect(msg).toContain("9 (Merge PR, escalated)");
    expect(msg).toContain("13 (Apply retro improvements, pending)");
  });

  it("never contains the false success banner (AC #9 truthfulness)", () => {
    const steps = stepsAll("complete");
    setStep(steps, 9, "in-progress");
    const msg = buildFinalizationGuardMessage(findIncompleteSteps(steps));

    expect(msg).not.toContain("Sprint complete");
  });
});

// ===========================================================================
// C4 — findNonTerminalFeatures (AC #6 invariant predicate)
// ===========================================================================

describe("findNonTerminalFeatures (C4, AC #6)", () => {
  function withStatuses(statuses: Record<string, FeatureState["status"]>): FeatureState[] {
    const features = createFeatureStates(Object.keys(statuses), SPRINT);
    for (const f of features) f.status = statuses[f.slug];
    return features;
  }

  it("returns [] when every feature is terminal — complete or escalated both count", () => {
    const features = withStatuses({ "feat-a": "complete", "feat-b": "escalated" });
    expect(findNonTerminalFeatures(features)).toEqual([]);
  });

  it("flags an 'in-progress' feature (the mid-retry-at-step-9 hole this gate closes)", () => {
    const features = withStatuses({ "feat-a": "complete", "feat-b": "in-progress" });

    const nonTerminal = findNonTerminalFeatures(features);
    expect(nonTerminal.map((f) => f.slug)).toEqual(["feat-b"]);
  });

  it("flags 'pending' and 'failed' features as non-terminal (architecture C4 filter verbatim)", () => {
    const features = withStatuses({
      "feat-a": "pending",
      "feat-b": "failed",
      "feat-c": "complete",
    });

    expect(findNonTerminalFeatures(features).map((f) => f.slug)).toEqual([
      "feat-a",
      "feat-b",
    ]);
  });

  it("does not mutate feature state (guards report, never repair — constraint 4)", () => {
    const features = withStatuses({ "feat-a": "in-progress" });
    const before = JSON.stringify(features);

    findNonTerminalFeatures(features);

    expect(JSON.stringify(features)).toBe(before);
  });
});

// ===========================================================================
// C4 — buildSharedStepGateMessage (NFR 6: names offending features)
// ===========================================================================

describe("buildSharedStepGateMessage (C4, AC #6)", () => {
  it("names the non-terminal feature and the step-9 boundary", () => {
    const features = createFeatureStates(["feat-beta"], SPRINT);
    features[0].status = "in-progress";
    const msg = buildSharedStepGateMessage(findNonTerminalFeatures(features));

    expect(msg).toContain("Shared steps blocked");
    expect(msg).toContain("feat-beta");
    expect(msg).toContain("not terminal at step 9");
  });

  it("lists every non-terminal feature slug", () => {
    const features = createFeatureStates(["feat-a", "feat-b"], SPRINT);
    features[0].status = "in-progress";
    features[1].status = "pending";
    const msg = buildSharedStepGateMessage(findNonTerminalFeatures(features));

    expect(msg).toContain("feat-a");
    expect(msg).toContain("feat-b");
  });

  it("never contains the false success banner (AC #9 truthfulness)", () => {
    const features = createFeatureStates(["feat-b"], SPRINT);
    features[0].status = "in-progress";
    const msg = buildSharedStepGateMessage(findNonTerminalFeatures(features));

    expect(msg).not.toContain("Sprint complete");
  });
});
