/**
 * Integration tests — user-actionable-failure-class (Sprint 15)
 *
 * Spec:         docs/specs/user-actionable-failure-class.md (AC 1-13)
 * Architecture: docs/architecture/user-actionable-failure-class.md
 *
 * TDD note: these tests target the contracts defined in the architecture doc —
 * the third `"user-actionable"` classification, the new
 * `USER_ACTIONABLE_ERROR_PATTERNS` registry and `resolveUserAction` helper in
 * `failure-classification.ts`, and the new escalate-now branch in the shared
 * `decideAfterFailure` pipeline in `runner.ts`. They are RED until the Engineer
 * implements — the expected state at step 3.
 *
 * ─── RED-VERIFICATION (TEAM.md QA rule 12) ──────────────────────────────────
 * Every constraint-guarding test below is proven to FAIL against the current
 * (pre-change) pipeline, where these errors classify `deterministic`:
 *   - The classification tests fail because `classifyFailure` returns
 *     `"deterministic"` for a spend-limit / invalid-model string today
 *     (`failure-classification.ts:45` walks only TRANSIENT_ERROR_PATTERNS).
 *   - `USER_ACTIONABLE_ERROR_PATTERNS` and `resolveUserAction` do not exist yet,
 *     so the imports below are a compile-time RED signal.
 *   - The `decideAfterFailure` escalate-now tests fail because today a
 *     user-actionable string takes the deterministic path: a billing error
 *     burns 2 attempts (CB-1 no-progress short-circuit on the identical
 *     signature) and an invalid-model error burns up to 3 (attempts-exhausted).
 *     The `runRetryLoop` harness below drives the REAL classify + decide seam
 *     and counts attempts against the actual counter (not a mock); pre-change it
 *     returns 2 / 3, post-change it must return 1.
 * How to re-verify RED: `git stash` the Engineer's change (or revert
 * failure-classification.ts + runner.ts) and re-run — every `it` in the
 * "user-actionable" describe blocks must fail.
 *
 * Surfaces intentionally NOT covered here: the exact stderr specimen the
 * `claude` CLI emits on an unknown `--model` (spec Open Question 2) is an
 * empirical unknown the Engineer must confirm against the live CLI and tune the
 * seed regex to; these tests assert the DOCUMENTED broad-regex candidates
 * (architecture §Components) so they pin the contract without over-fitting one
 * exact string. The escalation-message rendering at the two runner escalate
 * seams is covered by colocated runner unit tests; here we pin the pure
 * `decideAfterFailure` detail + `resolveUserAction`.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  classifyFailure,
  deriveFailureSignature,
  TRANSIENT_ERROR_PATTERNS,
  // New in Sprint 15 (RED until implemented):
  USER_ACTIONABLE_ERROR_PATTERNS,
  resolveUserAction,
  UserActionablePattern,
} from "../../src/orchestrator/failure-classification";
import {
  decideAfterFailure,
  MAX_RETRY_ATTEMPTS,
  RetryDecision,
} from "../../src/orchestrator/runner";
import { loadSprintState, FailureRecord, StepState } from "../../src/orchestrator/state";

const SLUG = "user-actionable-failure-class";

// Documented seed specimens (spec AC 4). The billing minimum specimen is exact
// (commits 908bf63, 9394bdd, f9bc035); the invalid-model candidates match the
// architecture's broad first-cut regex pending Open Question 2 confirmation.
const BILLING_SPECIMEN = "You've hit your monthly spend limit";
const INVALID_MODEL_SPECIMEN = "unknown model: definitely-not-a-real-model-xyz";

// ---------------------------------------------------------------------------
// Test builders (mirrors the progress-aware-circuit-breaker seam builders)
// ---------------------------------------------------------------------------

let failureCounter = 0;

function failure(overrides: Partial<FailureRecord> = {}): FailureRecord {
  failureCounter += 1;
  return {
    attempt: failureCounter,
    errorSummary: "agent produced no output",
    timestamp: "2026-07-07T00:00:00.000Z",
    hadPartialArtifacts: false,
    ...overrides,
  };
}

/** A failure with the class/signature stamped exactly as the runner records it. */
function classifiedFailure(errorSummary: string, overrides: Partial<FailureRecord> = {}): FailureRecord {
  return failure({
    errorSummary,
    classification: classifyFailure(errorSummary),
    signature: deriveFailureSignature(errorSummary),
    ...overrides,
  } as Partial<FailureRecord>);
}

function detFailure(signature: string, overrides: Partial<FailureRecord> = {}): FailureRecord {
  return failure({ classification: "deterministic", signature, ...overrides } as Partial<FailureRecord>);
}

/**
 * StepState after the new failure has been pushed. `attempts` keeps its frozen
 * meaning: deterministic attempts consumed (including a deterministic new one).
 */
function stepStateWith(failures: FailureRecord[], attempts?: number): StepState {
  const deterministic = failures.filter(
    (f) => ((f as FailureRecord & { classification?: string }).classification ?? "deterministic") === "deterministic"
  ).length;
  return {
    step: 5,
    role: "engineer",
    name: "Implement",
    status: "in-progress" as StepState["status"],
    artifacts: [],
    completedAt: null,
    attempts: attempts ?? deterministic,
    failures,
  };
}

const NO_SALVAGE = { complete: false, satisfied: [], missing: ["src/**/*.ts"] };

function lastFailure(state: StepState): FailureRecord {
  return state.failures[state.failures.length - 1];
}

function asEscalate(d: RetryDecision): Extract<RetryDecision, { kind: "escalate" }> {
  expect(d.kind).toBe("escalate");
  return d as Extract<RetryDecision, { kind: "escalate" }>;
}

/**
 * Attempt-counting harness that drives the REAL production decision seam
 * (`classifyFailure` + `decideAfterFailure`) with the runner's exact
 * attempt-accounting semantics from `processFailureAndDecide`
 * (runner.ts:501-537): provisionally increment `attempts`, push a
 * classified+signed record, ask the pure pipeline, roll back the increment on a
 * non-slot (transient) retry, and stop on escalate/salvage. The DECISION under
 * test is production code; only the loop scaffolding lives here. Returns how
 * many agent attempts were actually spent — asserted against the real counter,
 * never a mock (AC 11).
 */
function runRetryLoop(
  errorSummary: string,
  salvage = NO_SALVAGE,
  maxIterations = 12
): { decision: RetryDecision | null; attemptsSpent: number; state: StepState } {
  const state = stepStateWith([], 0);
  let attemptsSpent = 0;
  for (let i = 0; i < maxIterations; i++) {
    attemptsSpent += 1; // an agent attempt just ran and failed
    const record: FailureRecord = {
      attempt: attemptsSpent,
      errorSummary,
      timestamp: "2026-07-07T00:00:00.000Z",
      hadPartialArtifacts: false,
      classification: classifyFailure(errorSummary),
      signature: deriveFailureSignature(errorSummary),
    };
    state.attempts += 1; // provisional deterministic increment
    state.failures.push(record);
    const decision = decideAfterFailure(state, record, salvage);
    if (decision.kind === "retry") {
      if (!decision.consumesSlot) state.attempts -= 1; // transient rollback
      continue;
    }
    if (decision.kind === "escalate") {
      state.escalationReason = decision.reason as StepState["escalationReason"];
    }
    return { decision, attemptsSpent, state };
  }
  return { decision: null, attemptsSpent, state };
}

// ===========================================================================
// classifyFailure — third class (AC 1, 2, 4, 13)
// ===========================================================================

describe("classifyFailure — user-actionable class (AC 1-4)", () => {
  // RED-VERIFICATION: pre-change these all return "deterministic".
  it("classifies the billing spend-limit specimen as user-actionable", () => {
    expect(classifyFailure(BILLING_SPECIMEN)).toBe("user-actionable");
  });

  it.each([
    "You've hit your monthly spend limit",
    "Error: monthly spend limit exceeded for this account",
    "monthly usage limit reached",
    "usage limit reached — please raise your limit",
  ])("billing phrasing drift classifies user-actionable: %s", (msg) => {
    expect(classifyFailure(msg)).toBe("user-actionable");
  });

  it.each([
    "unknown model: definitely-not-a-real-model-xyz",
    "error: invalid model name provided",
    "unrecognized model requested",
    "model definitely-not-a-real-model does not exist",
    "the requested model is invalid",
    "model claude-bogus not found",
  ])("invalid-model rejection classifies user-actionable: %s", (msg) => {
    expect(classifyFailure(msg)).toBe("user-actionable");
  });

  it("a user-actionable failure is NOT transient and NOT deterministic (observable contract, AC 2)", () => {
    const cls = classifyFailure(BILLING_SPECIMEN);
    expect(cls).not.toBe("transient");
    expect(cls).not.toBe("deterministic");
  });

  it("precedence: a string matching BOTH user-actionable and transient resolves to user-actionable (Edge Case)", () => {
    // "usage limit reached" (user-actionable) also brushes transient /rate limit/ and /429/.
    const ambiguous = "usage limit reached (429 rate limit)";
    // Sanity: the transient registry really would claim this string on its own.
    expect(TRANSIENT_ERROR_PATTERNS.some((re) => re.test(ambiguous))).toBe(true);
    // But user-actionable is checked first, so escalate-now wins over retry-loop.
    expect(classifyFailure(ambiguous)).toBe("user-actionable");
  });

  it("no-regression: an unmatched error classifies exactly as today (AC 12)", () => {
    expect(classifyFailure("agent produced no output")).toBe("deterministic");
    expect(classifyFailure("TypeError: cannot read properties of undefined")).toBe("deterministic");
    expect(classifyFailure("socket connection closed unexpectedly")).toBe("transient");
  });
});

// ===========================================================================
// USER_ACTIONABLE_ERROR_PATTERNS registry (AC 3, 4, 13)
// ===========================================================================

describe("USER_ACTIONABLE_ERROR_PATTERNS registry (AC 3, 4, 13)", () => {
  it("is an enumerable code-only array of at least two seed entries", () => {
    expect(Array.isArray(USER_ACTIONABLE_ERROR_PATTERNS)).toBe(true);
    expect(USER_ACTIONABLE_ERROR_PATTERNS.length).toBeGreaterThanOrEqual(2);
  });

  it("every entry carries a RegExp pattern and a non-empty action string, no /g flag (AC 13)", () => {
    for (const entry of USER_ACTIONABLE_ERROR_PATTERNS as UserActionablePattern[]) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      // No /g flag: a stateful lastIndex would make classification non-deterministic.
      expect(entry.pattern.flags).not.toContain("g");
      expect(typeof entry.action).toBe("string");
      expect(entry.action.trim().length).toBeGreaterThan(0);
    }
  });

  it("ships a billing seed matching the spend-limit specimen (AC 4)", () => {
    expect(
      USER_ACTIONABLE_ERROR_PATTERNS.some((e) => e.pattern.test(BILLING_SPECIMEN))
    ).toBe(true);
  });

  it("ships an invalid-model seed matching the unknown-model rejection (AC 4)", () => {
    expect(
      USER_ACTIONABLE_ERROR_PATTERNS.some((e) => e.pattern.test(INVALID_MODEL_SPECIMEN))
    ).toBe(true);
  });
});

// ===========================================================================
// resolveUserAction — actionable message resolution (AC 7)
// ===========================================================================

describe("resolveUserAction (AC 7)", () => {
  it("names raising the usage limit for a billing failure", () => {
    const action = resolveUserAction(BILLING_SPECIMEN);
    expect(action).not.toBeNull();
    expect(action!.toLowerCase()).toContain("claude.ai/settings/usage");
  });

  it("names fixing models config for an invalid-model failure", () => {
    const action = resolveUserAction(INVALID_MODEL_SPECIMEN);
    expect(action).not.toBeNull();
    expect(action!).toContain("~/.raptor/config.json");
    expect(action!.toLowerCase()).toMatch(/models\.(byrole|default)/);
  });

  it("returns null when no user-actionable pattern matches", () => {
    expect(resolveUserAction("agent produced no output")).toBeNull();
    expect(resolveUserAction("socket connection closed unexpectedly")).toBeNull();
  });

  it("first-match-wins on a multi-match summary (registry order: billing before invalid-model, Open Question 3)", () => {
    const both = `${BILLING_SPECIMEN}. Also: ${INVALID_MODEL_SPECIMEN}`;
    const action = resolveUserAction(both);
    expect(action).not.toBeNull();
    // Billing is the first registry entry, so its action is named.
    expect(action!.toLowerCase()).toContain("claude.ai/settings/usage");
  });
});

// ===========================================================================
// decideAfterFailure — escalate-now pipeline branch (AC 5, 6, 7, 8)
// ===========================================================================

describe("decideAfterFailure — user-actionable escalate-now (AC 5-8)", () => {
  it("escalates on the FIRST attempt with reason user-actionable (AC 5, 6)", () => {
    const state = stepStateWith([classifiedFailure(BILLING_SPECIMEN)], 1);
    const esc = asEscalate(decideAfterFailure(state, lastFailure(state), NO_SALVAGE));
    expect(esc.reason).toBe("user-actionable");
  });

  it("the escalation detail names the concrete billing action (AC 7)", () => {
    const state = stepStateWith([classifiedFailure(BILLING_SPECIMEN)], 1);
    const esc = asEscalate(decideAfterFailure(state, lastFailure(state), NO_SALVAGE));
    expect(esc.detail.toLowerCase()).toContain("claude.ai/settings/usage");
  });

  it("the escalation detail names the concrete invalid-model action (AC 7)", () => {
    const state = stepStateWith([classifiedFailure(INVALID_MODEL_SPECIMEN)], 1);
    const esc = asEscalate(decideAfterFailure(state, lastFailure(state), NO_SALVAGE));
    expect(esc.detail).toContain("~/.raptor/config.json");
  });

  it("does NOT wait for the transient cap, no-progress short-circuit, or MAX_RETRY_ATTEMPTS (AC 5)", () => {
    // A single user-actionable failure, attempts far below MAX — still escalates now.
    const state = stepStateWith([classifiedFailure(BILLING_SPECIMEN)], 1);
    const decision = decideAfterFailure(state, lastFailure(state), NO_SALVAGE);
    expect(decision.kind).toBe("escalate");
    expect(decision.kind).not.toBe("retry");
  });

  it("escalate-now dominates remaining slot budget: user-actionable on attempt 2+ still escalates (Edge Case)", () => {
    // Step already burned one deterministic slot, then hits a spend limit.
    const failures = [detFailure("some-earlier-signature"), classifiedFailure(BILLING_SPECIMEN)];
    const state = stepStateWith(failures); // attempts derived: 1 deterministic + (billing not deterministic)
    const esc = asEscalate(decideAfterFailure(state, lastFailure(state), NO_SALVAGE));
    expect(esc.reason).toBe("user-actionable");
  });

  it("salvage-complete still wins over user-actionable (ordering: salvage > user-actionable, AC ordering)", () => {
    const state = stepStateWith([classifiedFailure(BILLING_SPECIMEN)], 1);
    const salvage = { complete: true, satisfied: ["src/orchestrator/foo.ts"], missing: [] };
    const decision = decideAfterFailure(state, lastFailure(state), salvage);
    expect(decision.kind).toBe("salvage-complete");
  });

  it("both loops parity: identical inputs yield identical user-actionable decisions (AC 8)", () => {
    const mk = () => stepStateWith([classifiedFailure(BILLING_SPECIMEN)], 1);
    const a = decideAfterFailure(mk(), lastFailure(mk()), { ...NO_SALVAGE, missing: [...NO_SALVAGE.missing] });
    const b = decideAfterFailure(mk(), lastFailure(mk()), { ...NO_SALVAGE, missing: [...NO_SALVAGE.missing] });
    expect(a).toEqual(b);
  });
});

// ===========================================================================
// Attempt-count contrast against the real seam (AC 11 — the RED baseline)
// ===========================================================================

describe("attempt accounting at the production seam (AC 11)", () => {
  it("a billing error escalates after exactly 1 attempt (pre-change: burns 2 via no-progress short-circuit)", () => {
    const { decision, attemptsSpent } = runRetryLoop(BILLING_SPECIMEN);
    expect(attemptsSpent).toBe(1);
    expect(decision).not.toBeNull();
    expect(asEscalate(decision!).reason).toBe("user-actionable");
  });

  it("an invalid-model error escalates after exactly 1 attempt (pre-change: burns up to 3)", () => {
    const { decision, attemptsSpent } = runRetryLoop(INVALID_MODEL_SPECIMEN);
    expect(attemptsSpent).toBe(1);
    expect(decision).not.toBeNull();
    expect(asEscalate(decision!).reason).toBe("user-actionable");
  });

  it("the harness records escalationReason on the step state (AC 9 recording path)", () => {
    const { state } = runRetryLoop(BILLING_SPECIMEN);
    expect(state.escalationReason).toBe("user-actionable");
  });
});

// ===========================================================================
// No-regression parity (AC 12) — the two existing classes are untouched
// ===========================================================================

describe("no-regression parity (AC 12)", () => {
  it("ordinary deterministic failures still consume slots and escalate at MAX_RETRY_ATTEMPTS", () => {
    const failures = Array.from({ length: MAX_RETRY_ATTEMPTS }, (_, i) => detFailure(`sig-${i}`));
    const state = stepStateWith(failures);
    const esc = asEscalate(decideAfterFailure(state, lastFailure(state), NO_SALVAGE));
    expect(esc.reason).toBe("attempts-exhausted");
  });

  it("first deterministic failure (distinct signature) still retries and consumes a slot", () => {
    const state = stepStateWith([detFailure("sig-1")]);
    expect(decideAfterFailure(state, lastFailure(state), NO_SALVAGE)).toEqual(
      expect.objectContaining({ kind: "retry", consumesSlot: true })
    );
  });

  it("a transient failure still retries WITHOUT consuming a slot (unchanged)", () => {
    const state = stepStateWith([classifiedFailure("socket connection closed unexpectedly")], 0);
    const decision = decideAfterFailure(state, lastFailure(state), NO_SALVAGE);
    expect(decision).toEqual(
      expect.objectContaining({ kind: "retry", consumesSlot: false })
    );
  });

  it("MAX_RETRY_ATTEMPTS is still 3 (untouched)", () => {
    expect(MAX_RETRY_ATTEMPTS).toBe(3);
  });
});

// ===========================================================================
// Recording & backward compatibility (AC 9, Edge Case: old state files)
// ===========================================================================

describe("FailureRecord recording & backward compatibility (AC 9)", () => {
  it("a user-actionable failure record carries the classification AND a derived signature (uniform records)", () => {
    const rec = classifiedFailure(BILLING_SPECIMEN);
    expect(rec.classification).toBe("user-actionable");
    // Open Question 4 ruling: keep records uniform — a signature is still derived.
    expect(typeof rec.signature).toBe("string");
    expect(rec.signature!.length).toBeGreaterThan(0);
  });

  describe("old state files without the new class load unchanged", () => {
    let tmpHome: string;
    let homedirSpy: jest.SpyInstance;
    const projectSlug = "uafc-compat-test";

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "uafc-home-"));
      homedirSpy = jest.spyOn(os, "homedir").mockReturnValue(tmpHome);
    });

    afterEach(() => {
      homedirSpy.mockRestore();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    });

    it("loads a pre-feature state file and defaults unclassified records to deterministic", () => {
      const stateDir = path.join(tmpHome, ".raptor", projectSlug);
      fs.mkdirSync(stateDir, { recursive: true });
      const legacy = {
        project: projectSlug,
        sprint: 14,
        status: "escalated",
        currentStep: 5,
        branchName: "sprint-14/some-feature",
        steps: [
          {
            step: 5,
            role: "engineer",
            name: "Implement",
            status: "escalated",
            artifacts: [],
            completedAt: null,
            attempts: 3,
            failures: [
              {
                attempt: 1,
                errorSummary: "You've hit your monthly spend limit",
                timestamp: "2026-07-01T10:00:00.000Z",
                hadPartialArtifacts: false,
              },
            ],
          },
        ],
        checkpoints: [],
        dod: {
          codeCommitted: false,
          testsPass: false,
          prReviewApproved: false,
          poAccepted: false,
          demoCompleted: false,
        },
        retroProposals: null,
      };
      fs.writeFileSync(path.join(stateDir, "sprint-14.json"), JSON.stringify(legacy));

      const state = loadSprintState(projectSlug, 14);
      expect(state).not.toBeNull();
      const rec = state!.steps[0].failures[0] as FailureRecord & { classification?: string };
      // No migration: the record keeps no classification and reads as deterministic.
      expect(rec.classification ?? "deterministic").toBe("deterministic");
    });
  });
});
