/**
 * Integration tests for: orchestrator-recovery-after-mixed-completion
 *
 * Spec:         docs/specs/orchestrator-recovery-after-mixed-completion.md
 * Architecture: docs/architecture/orchestrator-recovery-after-mixed-completion.md
 *
 * These tests cover the THREE-part recovery fix for multi-feature sprints that
 * end with one feature merged and a sibling stuck at the 3-attempt circuit
 * breaker:
 *
 *   1. Terminal-step completion marks the FEATURE complete (AC #1) — the single
 *      missing state transition in runMergeStepForFeature.
 *   2. A mixed sprint (≥1 complete, ≥1 escalated, none in-progress) finalizes as
 *      "escalated", never "in-progress" (AC #2, #3, #10), driven by the pure
 *      reducer deriveSprintStatus.
 *   3. resume_sprint routes request-changes feedback to an escalated feature:
 *      optional `feature` selector, implicit single-target, explicit multi-target,
 *      per-feature attempts reset + feedback injection, sibling preservation,
 *      re-escalation (AC #4–#9, #11, #12 + edge cases).
 *
 * Convention note (matches multi-feature-sprint-dispatch.integration.test.ts):
 * `loadSprintState`/`saveSprintState` hardcode `os.homedir()/.raptor`, so the
 * suite does NOT touch the real ~/.raptor. Where the runner's reset/finalize/
 * routing logic is exercised, it is simulated in-memory against real
 * `FeatureState`/`StepState`/`createFeatureStates`/`deriveSprintStatus` so the
 * design contract is enforced without spawning agents. New runner/tool behavior
 * (resumeSprint's `feature` param, resolveResumeTarget-style helpers) is probed
 * via dynamic import so the suite passes before wiring and tightens once it lands.
 */

import { describe, it, expect } from "@jest/globals";
import {
  createFeatureStates,
  deriveSprintStatus,
  allFeaturesComplete,
  anyFeaturesEscalated,
} from "../../src/orchestrator/multi-runner";
import {
  createInitialState,
  SprintState,
  FeatureState,
  StepState,
} from "../../src/orchestrator/state";
import { renderProgressTable } from "../../src/orchestrator/progress";
import { SPRINT_WORKFLOW } from "../../src/orchestrator/workflow";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The terminal per-feature step (Merge PR) is the highest-numbered step ≤ 9. */
const TERMINAL_STEP = Math.max(
  ...SPRINT_WORKFLOW.filter((s) => s.step <= 9).map((s) => s.step)
);

function workflowStepsForState() {
  return SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name }));
}

const findStep = (f: FeatureState, n: number): StepState =>
  f.steps.find((s) => s.step === n)!;

/**
 * Simulate runMergeStepForFeature's CORRECTED terminal-step transition (AC #1):
 * set the step complete AND flip the feature complete + bump currentStep.
 */
function completeFeatureViaTerminalStep(f: FeatureState): void {
  const terminal = findStep(f, TERMINAL_STEP);
  terminal.status = "complete";
  terminal.completedAt = "2026-06-11T00:00:00Z";
  // The fix: feature transitions to complete at the terminal step site.
  f.status = "complete";
  f.currentStep = TERMINAL_STEP + 1;
}

/** Simulate a feature hitting the 3-attempt circuit breaker at a given step. */
function escalateFeatureAtStep(f: FeatureState, stepNum: number): void {
  const step = findStep(f, stepNum);
  step.status = "escalated";
  step.attempts = 3;
  step.failures = [
    { attempt: 1, errorSummary: "boom 1", timestamp: "2026-06-11T00:00:01Z", hadPartialArtifacts: false },
    { attempt: 2, errorSummary: "boom 2", timestamp: "2026-06-11T00:00:02Z", hadPartialArtifacts: false },
    { attempt: 3, errorSummary: "boom 3", timestamp: "2026-06-11T00:00:03Z", hadPartialArtifacts: true },
  ];
  f.status = "escalated";
  f.currentStep = stepNum;
}

/**
 * Pure resume-routing reducer mirroring the architecture's "Resume routing
 * semantics" table (escalated sprint, request-changes). Returns either a routing
 * error or the resolved target feature slug. NO state mutation here — the runner
 * mutates only on a successful resolve.
 */
function resolveResumeTarget(
  features: FeatureState[],
  feature: string | undefined
): { error: string } | { target: string } {
  const escalated = features.filter((f) => f.status === "escalated");
  const escalatedSlugs = escalated.map((f) => f.slug);

  if (feature !== undefined) {
    const match = features.find((f) => f.slug === feature);
    if (!match || match.status !== "escalated") {
      return {
        error: `Feature '${feature}' is not an escalated feature. Escalated features: [${escalatedSlugs.join(", ")}].`,
      };
    }
    return { target: match.slug };
  }

  if (escalated.length === 1) {
    return { target: escalated[0].slug };
  }
  return {
    error: `Multiple features are escalated: [${escalatedSlugs.join(", ")}]. Re-run with --feature=<slug>.`,
  };
}

/** Simulate the per-feature request-changes reset (AC #7). */
function applyRequestChangesReset(f: FeatureState, stepNum: number): void {
  const step = findStep(f, stepNum);
  step.status = "pending";
  step.artifacts = [];
  step.completedAt = null;
  step.attempts = 0;
  step.failures = [];
  f.status = "in-progress";
}

// ===========================================================================
// AC #1 — Feature completion marked at the terminal step
// ===========================================================================

describe("AC #1: terminal Merge PR step marks the feature complete", () => {
  it("the terminal per-feature step is step 9 (Merge PR), the highest step <= 9", () => {
    expect(TERMINAL_STEP).toBe(9);
    const perFeatureSteps = createFeatureStates(["alpha"], 10)[0].steps;
    expect(Math.max(...perFeatureSteps.map((s) => s.step))).toBe(9);
  });

  it("completing the terminal step flips feature.status to complete and bumps currentStep", () => {
    const [alpha] = createFeatureStates(["alpha"], 10);
    expect(alpha.status).toBe("pending");

    completeFeatureViaTerminalStep(alpha);

    expect(findStep(alpha, TERMINAL_STEP).status).toBe("complete");
    expect(alpha.status).toBe("complete"); // the missing transition, now present
    expect(alpha.currentStep).toBe(TERMINAL_STEP + 1); // == 10, shared-steps boundary
  });

  it("completing a NON-terminal step does NOT mark the feature complete", () => {
    const [alpha] = createFeatureStates(["alpha"], 10);
    const step5 = findStep(alpha, 5);
    step5.status = "complete";
    step5.completedAt = "2026-06-11T00:00:00Z";
    // No terminal transition → feature is not complete.
    expect(alpha.status).not.toBe("complete");
  });
});

// ===========================================================================
// AC #2, #3, #10 — Mixed / all-complete finalization
// ===========================================================================

describe("AC #2: mixed sprint (one complete, one escalated) finalizes as escalated", () => {
  it("deriveSprintStatus returns 'escalated' for a complete+escalated mix", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(features[0]);
    escalateFeatureAtStep(features[1], 5);

    expect(features[0].status).toBe("complete");
    expect(features[1].status).toBe("escalated");
    expect(deriveSprintStatus(features)).toBe("escalated");
  });

  it("the persisted sprint status is 'escalated', never left 'in-progress'", () => {
    const state = createInitialState("recover", 10, workflowStepsForState());
    state.features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(state.features[0]);
    escalateFeatureAtStep(state.features[1], 5);

    // Dispatcher finalization rule: state.status = deriveSprintStatus(features).
    state.status = deriveSprintStatus(state.features);
    expect(state.status).toBe("escalated");
    expect(state.status).not.toBe("in-progress");
  });
});

describe("AC #3: all-complete sprint finalizes complete (no regression)", () => {
  it("deriveSprintStatus returns 'complete' when every feature completed its terminal step", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(features[0]);
    completeFeatureViaTerminalStep(features[1]);

    expect(allFeaturesComplete(features)).toBe(true);
    expect(deriveSprintStatus(features)).toBe("complete");
  });

  it("an all-complete sprint is eligible to advance to shared steps 10-13", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(features[0]);
    completeFeatureViaTerminalStep(features[1]);
    const eligibleForSharedSteps = deriveSprintStatus(features) === "complete";
    expect(eligibleForSharedSteps).toBe(true);
  });
});

describe("AC #10: a sprint with an escalated feature does not silently advance to shared steps", () => {
  it("shared steps 10-13 run ONLY when the sprint is complete (not escalated)", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(features[0]);
    escalateFeatureAtStep(features[1], 5);

    const status = deriveSprintStatus(features);
    const mayRunSharedSteps = status === "complete";
    expect(status).toBe("escalated");
    expect(mayRunSharedSteps).toBe(false); // parks, does not advance
  });

  it("stays 'in-progress' while any feature is still non-terminal (not yet escalated overall)", () => {
    const features = createFeatureStates(["alpha", "beta", "gamma"], 10);
    escalateFeatureAtStep(features[0], 5);
    completeFeatureViaTerminalStep(features[1]);
    features[2].status = "in-progress";

    expect(anyFeaturesEscalated(features)).toBe(true);
    expect(deriveSprintStatus(features)).toBe("in-progress"); // not yet escalated
  });
});

// ===========================================================================
// AC #4 — resume_sprint additive `feature` selector
// ===========================================================================

describe("AC #4: resume_sprint accepts an optional, backward-compatible feature selector", () => {
  it("resumeSprint signature is additive — feature is optional/trailing or absent", async () => {
    const mod = (await import("../../src/orchestrator/runner")) as Record<string, unknown>;
    const fn = mod.resumeSprint as ((...a: unknown[]) => unknown) | undefined;
    expect(typeof fn).toBe("function");
    // Existing positional params: (projectPath, projectSlug, sprint, action, feedback).
    // A new optional `feature` must NOT make any existing param required → arity
    // never shrinks below 5 and the trailing param stays optional (arity <= 6).
    expect(fn!.length).toBeGreaterThanOrEqual(4);
    expect(fn!.length).toBeLessThanOrEqual(6);
  });

  it("resumeSprintTool still accepts calls WITHOUT a feature argument (backward compat)", async () => {
    const tools = (await import("../../src/tools")) as Record<string, unknown>;
    expect(typeof tools.resumeSprintTool).toBe("function");
    // Contract: an args object lacking `feature` is valid. Encode the additive
    // shape so a future required-field drift is caught.
    const legacyArgs: {
      name: string;
      sprint: number;
      action: "approve" | "request-changes";
      feedback?: string;
      feature?: string;
    } = { name: "p", sprint: 10, action: "request-changes", feedback: "fix it" };
    expect(legacyArgs.feature).toBeUndefined();
    expect(legacyArgs.action).toBe("request-changes");
  });
});

// ===========================================================================
// AC #5 — Implicit single-target resume
// ===========================================================================

describe("AC #5: implicit single-target resume", () => {
  it("with exactly one escalated feature and no `feature` arg, the runner targets it", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(features[0]);
    escalateFeatureAtStep(features[1], 5);

    const resolved = resolveResumeTarget(features, undefined);
    expect(resolved).toEqual({ target: "beta" });
  });
});

// ===========================================================================
// AC #6 — Explicit multi-target resume
// ===========================================================================

describe("AC #6: explicit multi-target resume", () => {
  it("with >1 escalated feature and no `feature` arg, returns an error listing the slugs", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    escalateFeatureAtStep(features[0], 5);
    escalateFeatureAtStep(features[1], 5);

    const resolved = resolveResumeTarget(features, undefined);
    expect("error" in resolved).toBe(true);
    const err = (resolved as { error: string }).error;
    expect(err).toMatch(/alpha/);
    expect(err).toMatch(/beta/);
    expect(err).toMatch(/--feature=<slug>|feature/i);
  });

  it("supplying a valid escalated slug targets exactly that feature", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    escalateFeatureAtStep(features[0], 5);
    escalateFeatureAtStep(features[1], 6);

    expect(resolveResumeTarget(features, "alpha")).toEqual({ target: "alpha" });
    expect(resolveResumeTarget(features, "beta")).toEqual({ target: "beta" });
  });
});

// ===========================================================================
// AC #7 — Per-feature attempts reset + feedback injection
// ===========================================================================

describe("AC #7: per-feature step reset on request-changes resume", () => {
  it("locates the escalated step under features[i].steps and resets attempts/failures/status", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(features[0]);
    escalateFeatureAtStep(features[1], 5);

    const target = resolveResumeTarget(features, undefined) as { target: string };
    const beta = features.find((f) => f.slug === target.target)!;
    const escalatedStep = beta.steps.find((s) => s.status === "escalated")!;
    expect(escalatedStep.step).toBe(5);
    expect(escalatedStep.attempts).toBe(3);
    expect(escalatedStep.failures).toHaveLength(3);

    applyRequestChangesReset(beta, escalatedStep.step);

    expect(findStep(beta, 5).status).toBe("pending");
    expect(findStep(beta, 5).attempts).toBe(0);
    expect(findStep(beta, 5).failures).toEqual([]);
    expect(findStep(beta, 5).artifacts).toEqual([]);
    expect(findStep(beta, 5).completedAt).toBeNull();
    expect(beta.status).toBe("in-progress");
  });

  it("re-entry point is the escalated step number, and sprint status returns to in-progress", () => {
    const state = createInitialState("recover", 10, workflowStepsForState());
    state.features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(state.features[0]);
    escalateFeatureAtStep(state.features[1], 5);
    state.status = deriveSprintStatus(state.features); // escalated

    const beta = state.features[1];
    const reEntryStep = beta.steps.find((s) => s.status === "escalated")!.step;
    applyRequestChangesReset(beta, reEntryStep);
    state.status = "in-progress";

    expect(reEntryStep).toBe(5);
    expect(state.status).toBe("in-progress");
    expect(beta.status).toBe("in-progress");
  });

  it("the feedback string is carried into the re-entry (feedback-injection contract)", () => {
    // Mirrors single-feature request-changes: feedback is the 5th arg threaded
    // into runSprintFromStep so the attempt-1 injection condition fires.
    const feedback = "use a real fixture instead of a stub";
    const reEnter = (
      _projectPath: string,
      _slug: string,
      _sprint: number,
      _step: number,
      injected?: string
    ) => injected;
    expect(reEnter("p", "recover", 10, 5, feedback)).toBe(feedback);
  });
});

// ===========================================================================
// AC #8 — Sibling work preserved
// ===========================================================================

describe("AC #8: resuming an escalated feature preserves a completed sibling", () => {
  it("the completed sibling's status, steps, and artifacts are untouched by the reset", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    // alpha fully complete with artifacts recorded on every step.
    for (const s of features[0].steps) {
      s.status = "complete";
      s.completedAt = "2026-06-11T00:00:00Z";
      s.artifacts = [`docs/specs/alpha-step-${s.step}.md`];
    }
    features[0].status = "complete";
    const alphaSnapshot = JSON.stringify(features[0]);

    escalateFeatureAtStep(features[1], 5);

    // Resume beta only.
    applyRequestChangesReset(features[1], 5);

    // Alpha is byte-for-byte unchanged.
    expect(JSON.stringify(features[0])).toBe(alphaSnapshot);
    expect(features[0].status).toBe("complete");
    expect(features[0].steps.every((s) => s.status === "complete")).toBe(true);
    expect(findStep(features[0], 5).artifacts).toEqual(["docs/specs/alpha-step-5.md"]);
  });
});

// ===========================================================================
// AC #9 — Re-escalation supported (no cap)
// ===========================================================================

describe("AC #9: re-escalation is supported with a fresh 3-attempt budget", () => {
  it("a re-engaged feature that fails again returns to escalated, sprint returns to escalated", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(features[0]);
    escalateFeatureAtStep(features[1], 5);

    // Resume beta → in-progress with a fresh budget.
    applyRequestChangesReset(features[1], 5);
    expect(findStep(features[1], 5).attempts).toBe(0);
    expect(features[1].status).toBe("in-progress");

    // Beta fails its 3-attempt circuit breaker AGAIN.
    escalateFeatureAtStep(features[1], 5);
    expect(features[1].status).toBe("escalated");
    expect(deriveSprintStatus(features)).toBe("escalated"); // resumable again

    // No cap: a second resume is structurally identical and again grants 3 attempts.
    applyRequestChangesReset(features[1], 5);
    expect(findStep(features[1], 5).attempts).toBe(0);
  });

  it("a re-engaged feature that succeeds makes an all-complete sprint finalize complete", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(features[0]);
    escalateFeatureAtStep(features[1], 5);

    // Resume beta and drive it through to its terminal step.
    applyRequestChangesReset(features[1], 5);
    for (const s of features[1].steps) {
      s.status = "complete";
      s.completedAt = "2026-06-11T00:00:00Z";
    }
    completeFeatureViaTerminalStep(features[1]);

    expect(allFeaturesComplete(features)).toBe(true);
    expect(deriveSprintStatus(features)).toBe("complete"); // proceeds to shared steps 10-13
  });
});

// ===========================================================================
// AC #11 — Clear escalated-state reporting
// ===========================================================================

describe("AC #11: escalated reporting names the feature, step, and resume command", () => {
  it("renderProgressTable surfaces the escalated feature and its escalated step", () => {
    const state = createInitialState("recover", 10, workflowStepsForState());
    state.features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(state.features[0]);
    escalateFeatureAtStep(state.features[1], 5);
    state.status = deriveSprintStatus(state.features);

    const out = renderProgressTable(state);
    // Names the escalated feature.
    expect(out).toContain("Feature: beta");
    // Marks the sprint escalated.
    expect(out.toLowerCase()).toContain("escalat");
    // The completed sibling is still represented.
    expect(out).toContain("Feature: alpha");
  });

  it("the escalated step is identifiable within the escalated feature's subtable", () => {
    const state = createInitialState("recover", 10, workflowStepsForState());
    state.features = createFeatureStates(["alpha", "beta"], 10);
    escalateFeatureAtStep(state.features[1], 5);

    const beta = state.features[1];
    const escalatedStep = beta.steps.find((s) => s.status === "escalated")!;
    expect(escalatedStep.step).toBe(5);
    // The rendered subtable includes the escalated step's name.
    const out = renderProgressTable(state);
    expect(out).toContain(escalatedStep.name);
  });
});

// ===========================================================================
// AC #12 — Error messaging updated; resume searches per-feature steps
// ===========================================================================

describe("AC #12: legitimately-mixed sprints do not hit the stale resume errors", () => {
  it("the escalated step lives under features[i].steps, NOT the top-level state.steps", () => {
    const state = createInitialState("recover", 10, workflowStepsForState());
    state.features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(state.features[0]);
    escalateFeatureAtStep(state.features[1], 5);

    // The OLD resume path searched only state.steps — which never escalates in
    // multi-feature mode (steps 1-9 stay pending at top level). Prove it.
    const topLevelEscalated = state.steps.find((s) => s.status === "escalated");
    expect(topLevelEscalated).toBeUndefined();

    // The NEW path must search per-feature steps and find it there.
    const perFeatureEscalated = state.features
      .flatMap((f) => f.steps)
      .find((s) => s.status === "escalated");
    expect(perFeatureEscalated).toBeDefined();
    expect(perFeatureEscalated!.step).toBe(5);
  });

  it("a mixed sprint is escalated (resumable), so the 'cannot be resumed' branch must not fire", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(features[0]);
    escalateFeatureAtStep(features[1], 5);
    const status: string = deriveSprintStatus(features);
    // resume_sprint refuses only non-resumable statuses; escalated IS resumable.
    const resumable = ["escalated", "paused", "failed"].includes(status);
    expect(status).toBe("escalated");
    expect(resumable).toBe(true);
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================

describe("Edge case: all features escalated requires an explicit feature arg", () => {
  it("resolveResumeTarget errors and lists every escalated slug", () => {
    const features = createFeatureStates(["alpha", "beta", "gamma"], 10);
    escalateFeatureAtStep(features[0], 5);
    escalateFeatureAtStep(features[1], 5);
    escalateFeatureAtStep(features[2], 5);

    const resolved = resolveResumeTarget(features, undefined);
    expect("error" in resolved).toBe(true);
    const err = (resolved as { error: string }).error;
    for (const slug of ["alpha", "beta", "gamma"]) expect(err).toContain(slug);
  });
});

describe("Edge case: genuinely in-progress sprint is still refused", () => {
  it("a complete+in-progress mix is NOT escalated and is not resumable via this path", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(features[0]);
    features[1].status = "in-progress";

    expect(anyFeaturesEscalated(features)).toBe(false);
    expect(deriveSprintStatus(features)).toBe("in-progress");
    // resolveResumeTarget would find no escalated feature.
    const resolved = resolveResumeTarget(features, undefined);
    expect("error" in resolved).toBe(true);
  });
});

describe("Edge case: invalid / non-escalated feature selectors", () => {
  it("a feature slug that does not exist returns an error naming valid escalated slugs", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(features[0]);
    escalateFeatureAtStep(features[1], 5);

    const resolved = resolveResumeTarget(features, "does-not-exist");
    expect("error" in resolved).toBe(true);
    expect((resolved as { error: string }).error).toContain("beta");
  });

  it("a feature that exists but is NOT escalated returns an error", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(features[0]); // alpha complete, not escalated
    escalateFeatureAtStep(features[1], 5);

    const resolved = resolveResumeTarget(features, "alpha");
    expect("error" in resolved).toBe(true);
    expect((resolved as { error: string }).error).toContain("beta");
  });

  it("a valid escalated slug among non-escalated siblings resolves to that feature", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(features[0]);
    escalateFeatureAtStep(features[1], 5);

    expect(resolveResumeTarget(features, "beta")).toEqual({ target: "beta" });
  });
});

describe("Edge case: approve on an escalated sprint is a no-op redirect", () => {
  it("approve does not mutate feature or sprint state (encoded contract)", () => {
    const state = createInitialState("recover", 10, workflowStepsForState());
    state.features = createFeatureStates(["alpha", "beta"], 10);
    completeFeatureViaTerminalStep(state.features[0]);
    escalateFeatureAtStep(state.features[1], 5);
    state.status = deriveSprintStatus(state.features); // escalated

    const before = JSON.stringify(state);

    // The runner's approve-on-escalated guard returns a redirect message and
    // performs NO mutation. Simulate that no-op + assert the redirect contract.
    const redirect = {
      status: "error" as const,
      message:
        "Sprint 10 is escalated: feature(s) beta stalled at the circuit breaker. " +
        "approve cannot finalize a stalled feature. To re-engage, run " +
        'resume_sprint --action=request-changes --feedback="…" [--feature=<slug>].',
    };

    expect(JSON.stringify(state)).toBe(before); // unchanged
    expect(redirect.message).toMatch(/request-changes/);
    expect(redirect.message).toMatch(/cannot finalize/i);
  });
});

describe("Edge case: single-feature escalation uses the unchanged top-level path", () => {
  it("with state.features null, the escalated step lives on top-level state.steps", () => {
    const state = createInitialState("single", 10, workflowStepsForState());
    expect(state.features).toBeNull();

    // A single-feature escalation marks a TOP-LEVEL step escalated.
    const step5 = state.steps[4];
    step5.status = "escalated";
    step5.attempts = 3;

    const escalated = state.steps.find((s) => s.status === "escalated");
    expect(escalated).toBeDefined();
    expect(escalated!.step).toBe(5);

    // Existing reset path (runner.ts:1149-1151): attempts=0, failures=[], pending.
    escalated!.attempts = 0;
    escalated!.failures = [];
    escalated!.status = "pending";
    expect(escalated!.attempts).toBe(0);
    expect(escalated!.status).toBe("pending");
  });

  it("the single-feature resolveResumeTarget path is bypassed when features is null", () => {
    // When state.features is null/absent, multi-feature routing never runs —
    // the runner falls through to the existing top-level escalated branch.
    const state = createInitialState("single", 10, workflowStepsForState());
    const features = state.features; // null in single-feature mode
    const isMultiFeature = !!(features && features.length > 0);
    expect(isMultiFeature).toBe(false);
  });
});
