/**
 * Unit tests — progress-table decision visibility (Sprint 12, AC 22)
 *
 * Feature:      progress-aware-circuit-breaker
 * Spec:         docs/specs/progress-aware-circuit-breaker.md (AC 22)
 * Architecture: docs/architecture/progress-aware-circuit-breaker.md §4
 *
 * Every new decision path must be visible in progress reporting — no silent
 * branches. The architecture names the exact variants: `complete (salvaged)`,
 * `escalated (no progress)`, `escalated (transient cap)`.
 */

import { describe, it, expect } from "@jest/globals";
import { renderProgressTable } from "./progress";
import { createInitialState } from "./state";
import { createFeatureStates } from "./multi-runner";

function baseState() {
  return createInitialState("pacb", 12, [
    { step: 3, role: "qa", name: "Write tests" },
  ]);
}

describe("renderProgressTable — circuit-breaker decision visibility (AC 22)", () => {
  it("shows complete (salvaged) for salvage-completed steps", () => {
    const state = baseState();
    state.steps[0].status = "complete";
    state.steps[0].completedVia = "salvage";

    expect(renderProgressTable(state)).toContain("complete (salvaged)");
  });

  it("shows escalated (no progress) for short-circuited steps", () => {
    const state = baseState();
    state.status = "escalated";
    state.steps[0].status = "escalated";
    state.steps[0].attempts = 2;
    state.steps[0].escalationReason = "no-progress";

    expect(renderProgressTable(state)).toContain("escalated (no progress)");
  });

  it("shows escalated (transient cap) for transient-cap escalations", () => {
    const state = baseState();
    state.status = "escalated";
    state.steps[0].status = "escalated";
    state.steps[0].escalationReason = "transient-cap";

    expect(renderProgressTable(state)).toContain("escalated (transient cap)");
  });

  it("keeps today's display for legacy escalations without an escalationReason", () => {
    const state = baseState();
    state.status = "escalated";
    state.steps[0].status = "escalated";
    state.steps[0].attempts = 3;

    expect(renderProgressTable(state)).toContain("escalated (3/3)");
  });

  it("renders the same variants on per-feature rows in multi-feature mode", () => {
    const state = baseState();
    state.features = createFeatureStates(["alpha", "beta"], 12);
    const alphaStep = state.features[0].steps.find((s) => s.step === 3)!;
    alphaStep.status = "complete";
    alphaStep.completedVia = "salvage";
    const betaStep = state.features[1].steps.find((s) => s.step === 3)!;
    betaStep.status = "escalated";
    betaStep.escalationReason = "no-progress";
    state.features[1].status = "escalated";

    const table = renderProgressTable(state);
    expect(table).toContain("complete (salvaged)");
    expect(table).toContain("escalated (no progress)");
  });
});
