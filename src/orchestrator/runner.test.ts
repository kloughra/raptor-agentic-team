/**
 * Unit tests for: orchestrator-recovery-after-mixed-completion
 *
 * Spec:         docs/specs/orchestrator-recovery-after-mixed-completion.md
 * Architecture: docs/architecture/orchestrator-recovery-after-mixed-completion.md
 *
 * These unit tests exercise the new PURE, exported helpers that back the
 * three-part recovery fix without touching the filesystem or spawning agents:
 *
 *   - resolveEscalatedResumeTarget — resume routing semantics (AC #5, #6, edges)
 *   - buildMultiFeatureEscalatedMessage — escalated reporting (AC #11)
 *
 * The end-to-end dispatcher/resume wiring (terminal-step completion, finalize,
 * re-entry) is covered by the sibling integration test.
 */

import { describe, it, expect } from "@jest/globals";
import {
  resolveEscalatedResumeTarget,
  buildMultiFeatureEscalatedMessage,
  buildSalvageSection,
} from "./runner";
import { createFeatureStates, deriveSprintStatus } from "./multi-runner";
import { FeatureState, StepState, createInitialState } from "./state";

const findStep = (f: FeatureState, n: number): StepState =>
  f.steps.find((s) => s.step === n)!;

function completeTerminal(f: FeatureState): void {
  const terminal = findStep(f, 9);
  terminal.status = "complete";
  terminal.completedAt = "2026-06-11T00:00:00Z";
  f.status = "complete";
  f.currentStep = 10;
}

function escalateAt(f: FeatureState, stepNum: number): void {
  const step = findStep(f, stepNum);
  step.status = "escalated";
  step.attempts = 3;
  step.failures = [
    { attempt: 1, errorSummary: "boom 1", timestamp: "t1", hadPartialArtifacts: false },
    { attempt: 2, errorSummary: "boom 2", timestamp: "t2", hadPartialArtifacts: false },
    { attempt: 3, errorSummary: "boom 3", timestamp: "t3", hadPartialArtifacts: true },
  ];
  f.status = "escalated";
  f.currentStep = stepNum;
}

// ===========================================================================
// resolveEscalatedResumeTarget — AC #5, #6 + edge cases
// ===========================================================================

describe("resolveEscalatedResumeTarget", () => {
  it("implicitly targets the only escalated feature when no `feature` is given (AC #5)", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeTerminal(features[0]);
    escalateAt(features[1], 5);

    expect(resolveEscalatedResumeTarget(features, undefined)).toEqual({
      ok: true,
      target: "beta",
    });
  });

  it("errors and lists all escalated slugs when >1 escalated and no `feature` (AC #6)", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    escalateAt(features[0], 5);
    escalateAt(features[1], 6);

    const res = resolveEscalatedResumeTarget(features, undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/alpha/);
      expect(res.error).toMatch(/beta/);
      expect(res.error).toMatch(/--feature=<slug>|feature/i);
    }
  });

  it("targets an explicitly supplied valid escalated slug (AC #6)", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    escalateAt(features[0], 5);
    escalateAt(features[1], 6);

    expect(resolveEscalatedResumeTarget(features, "alpha")).toEqual({
      ok: true,
      target: "alpha",
    });
    expect(resolveEscalatedResumeTarget(features, "beta")).toEqual({
      ok: true,
      target: "beta",
    });
  });

  it("errors when the supplied slug does not exist, naming valid escalated slugs (edge)", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeTerminal(features[0]);
    escalateAt(features[1], 5);

    const res = resolveEscalatedResumeTarget(features, "does-not-exist");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("beta");
  });

  it("errors when the supplied slug exists but is NOT escalated (edge)", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeTerminal(features[0]); // alpha complete, not escalated
    escalateAt(features[1], 5);

    const res = resolveEscalatedResumeTarget(features, "alpha");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("beta");
  });

  it("all-features-escalated with no `feature` errors and lists every slug (edge)", () => {
    const features = createFeatureStates(["alpha", "beta", "gamma"], 10);
    escalateAt(features[0], 5);
    escalateAt(features[1], 5);
    escalateAt(features[2], 5);

    const res = resolveEscalatedResumeTarget(features, undefined);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      for (const slug of ["alpha", "beta", "gamma"]) expect(res.error).toContain(slug);
    }
  });

  it("returns an error when there are no escalated features at all (genuinely in-progress)", () => {
    const features = createFeatureStates(["alpha", "beta"], 10);
    completeTerminal(features[0]);
    features[1].status = "in-progress";

    const res = resolveEscalatedResumeTarget(features, undefined);
    expect(res.ok).toBe(false);
  });
});

// ===========================================================================
// buildMultiFeatureEscalatedMessage — AC #11
// ===========================================================================

describe("buildMultiFeatureEscalatedMessage", () => {
  it("names the escalated feature, its step, and the resume command (single target)", () => {
    const state = createInitialState("recover", 10, []);
    state.features = createFeatureStates(["alpha", "beta"], 10);
    completeTerminal(state.features[0]);
    escalateAt(state.features[1], 5);
    state.status = deriveSprintStatus(state.features);

    const msg = buildMultiFeatureEscalatedMessage(state, 10);
    expect(msg).toContain("beta");
    expect(msg).toContain("5"); // step number
    expect(msg).toMatch(/resume_sprint/);
    expect(msg).toMatch(/request-changes/);
    // exactly one escalated → the optional [--feature=<slug>] hint form
    expect(msg).toMatch(/\[--feature=<slug>\]/);
  });

  it("lists every escalated feature and requires --feature when more than one", () => {
    const state = createInitialState("recover", 10, []);
    state.features = createFeatureStates(["alpha", "beta"], 10);
    escalateAt(state.features[0], 5);
    escalateAt(state.features[1], 6);
    state.status = deriveSprintStatus(state.features);

    const msg = buildMultiFeatureEscalatedMessage(state, 10);
    expect(msg).toContain("alpha");
    expect(msg).toContain("beta");
    // more than one escalated → the required --feature=<slug> form (no brackets)
    expect(msg).toMatch(/--feature=<slug>/);
  });
});

// ===========================================================================
// buildSalvageSection — partial-artifact salvage task-description rendering
// (Sprint 12, progress-aware-circuit-breaker, CB-4 AC 14; PO test-review
// Condition A: the salvage section must list existing-vs-missing with the
// do-not-recreate instruction)
// ===========================================================================

describe("buildSalvageSection (CB-4, AC 14)", () => {
  it("lists already-existing validated files with a do-not-recreate instruction", () => {
    const section = buildSalvageSection({
      complete: false,
      satisfied: ["tests/bdd/*.feature (tests/bdd/my-feature.feature)"],
      missing: ["tests/integration/*"],
    });

    expect(section).toContain("tests/bdd/my-feature.feature");
    expect(section).toMatch(/do NOT recreate/i);
    expect(section).toMatch(/build on them/i);
  });

  it("lists the still-missing patterns as this attempt's actual job", () => {
    const section = buildSalvageSection({
      complete: false,
      satisfied: ["tests/bdd/*.feature (tests/bdd/my-feature.feature)"],
      missing: ["tests/integration/*"],
    });

    expect(section).toContain("tests/integration/*");
    expect(section).toMatch(/still missing/i);
    expect(section).toMatch(/actual job/i);
  });

  it("renders nothing when no expected outputs were salvaged", () => {
    const section = buildSalvageSection({
      complete: false,
      satisfied: [],
      missing: ["tests/bdd/*.feature", "tests/integration/*"],
    });

    expect(section).toBe("");
  });
});
