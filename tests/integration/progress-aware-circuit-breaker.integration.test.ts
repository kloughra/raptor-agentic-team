/**
 * Integration tests — progress-aware-circuit-breaker (Sprint 12)
 *
 * Spec:         docs/specs/progress-aware-circuit-breaker.md (AC 1–22)
 * Architecture: docs/architecture/progress-aware-circuit-breaker.md
 *
 * TDD note: these tests target the contracts defined in the architecture doc
 * (new module `failure-classification.ts`, `decideAfterFailure`/`checkSalvage`
 * exports from runner.ts, `HARD_CEILING_MS` from timeouts.ts, `timeouts`
 * parsing in loadConfig). They are RED until the Engineer implements — that
 * is the expected state at step 3.
 *
 * Surfaces intentionally NOT covered here (per the architecture test-surface
 * map): the spawnAgent idle-timer/ceiling mechanics need fake child processes
 * and fake timers → colocated unit tests in src/orchestrator/agents.test.ts.
 * The partial-salvage task-description rendering lives in the unexported
 * buildTaskDescription → colocated unit tests in src/orchestrator/runner.test.ts.
 * This file pins the pure decision pipeline, the salvage gate against a real
 * filesystem, config plumbing end-to-end, and state backward compatibility.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  classifyFailure,
  deriveFailureSignature,
  TRANSIENT_ERROR_PATTERNS,
  TRANSIENT_RETRY_CAP,
  TRANSIENT_RETRY_DELAY_MS,
} from "../../src/orchestrator/failure-classification";
import {
  decideAfterFailure,
  checkSalvage,
  MAX_RETRY_ATTEMPTS,
  RetryDecision,
} from "../../src/orchestrator/runner";
import {
  HARD_CEILING_MS,
  MAX_TIMEOUT_MS,
  resolveStepTimeout,
} from "../../src/orchestrator/timeouts";
import { loadConfig } from "../../src/config";
import { loadSprintState, FailureRecord, StepState } from "../../src/orchestrator/state";
import { SPRINT_WORKFLOW, WorkflowStep } from "../../src/orchestrator/workflow";
import { AgentResult } from "../../src/orchestrator/agents";

const SLUG = "progress-aware-circuit-breaker";

// ---------------------------------------------------------------------------
// Test builders
// ---------------------------------------------------------------------------

let failureCounter = 0;

function failure(overrides: Partial<FailureRecord> = {}): FailureRecord {
  failureCounter += 1;
  return {
    attempt: failureCounter,
    errorSummary: "agent produced no output",
    timestamp: "2026-07-06T00:00:00.000Z",
    hadPartialArtifacts: false,
    ...overrides,
  };
}

/** A deterministic failure with a persisted signature (as the runner records it). */
function detFailure(signature: string, overrides: Partial<FailureRecord> = {}): FailureRecord {
  return failure({
    classification: "deterministic",
    signature,
    ...overrides,
  } as Partial<FailureRecord>);
}

/** A transient failure with a persisted signature. */
function transFailure(signature: string, overrides: Partial<FailureRecord> = {}): FailureRecord {
  return failure({
    errorSummary: "socket connection closed unexpectedly",
    classification: "transient",
    signature,
    ...overrides,
  } as Partial<FailureRecord>);
}

/**
 * StepState after the new failure has been pushed (decideAfterFailure's
 * contract: "already pushed, already classified/signed"). `attempts` carries
 * its frozen meaning: deterministic attempts consumed, INCLUDING the new
 * failure when it is deterministic.
 */
function stepStateWith(failures: FailureRecord[], attempts?: number): StepState {
  const deterministic = failures.filter(
    (f) => ((f as FailureRecord & { classification?: string }).classification ?? "deterministic") === "deterministic"
  ).length;
  return {
    step: 3,
    role: "qa",
    name: "Write tests",
    status: "in-progress" as StepState["status"],
    artifacts: [],
    completedAt: null,
    attempts: attempts ?? deterministic,
    failures,
  };
}

const NO_SALVAGE = { complete: false, satisfied: [], missing: ["tests/bdd/*.feature", "tests/integration/*"] };

function lastFailure(state: StepState): FailureRecord {
  return state.failures[state.failures.length - 1];
}

// ---------------------------------------------------------------------------
// failure-classification.ts — classifyFailure (CB-2, AC 5-6)
// ---------------------------------------------------------------------------

describe("classifyFailure (CB-2)", () => {
  it("classifies the Sprint 11 specimen as transient (AC 6 minimum)", () => {
    expect(classifyFailure("socket connection closed unexpectedly")).toBe("transient");
  });

  it.each([
    "ECONNRESET while calling API",
    "connect ECONNREFUSED 127.0.0.1:443",
    "request failed: ETIMEDOUT",
    "getaddrinfo ENOTFOUND api.anthropic.com",
    "getaddrinfo EAI_AGAIN api.anthropic.com",
    "write EPIPE",
    "TypeError: fetch failed",
    '{"type":"error","error":{"type":"overloaded_error"}}',
    "HTTP 429: rate limit exceeded",
    "502 bad gateway",
    "503 service unavailable",
  ])("classifies infra-level error as transient: %s", (msg) => {
    expect(classifyFailure(msg)).toBe("transient");
  });

  it.each([
    "agent produced no output",
    "agent output exceeded 10MB buffer",
    "agent idle-killed after 1800000ms with no stdout output",
    "Agent completed (exit 0) but did not create required output files: tests/bdd/*.feature. The step is not complete until these files exist on disk.",
    "Missing required artifacts: docs/specs/progress-aware-circuit-breaker.md",
    "TypeError: Cannot read properties of undefined",
  ])("classifies task-level error as deterministic: %s", (msg) => {
    expect(classifyFailure(msg)).toBe("deterministic");
  });

  it("exposes an extensible, enumerable pattern registry (code-only this sprint)", () => {
    expect(Array.isArray(TRANSIENT_ERROR_PATTERNS)).toBe(true);
    expect(TRANSIENT_ERROR_PATTERNS.length).toBeGreaterThanOrEqual(1);
    // Every registered pattern must classify its own matches as transient
    expect(
      TRANSIENT_ERROR_PATTERNS.some((re: RegExp) => re.test("socket connection closed unexpectedly"))
    ).toBe(true);
  });

  it("pins the Architect-ruled constants: cap 5, fixed 15s delay", () => {
    expect(TRANSIENT_RETRY_CAP).toBe(5);
    expect(TRANSIENT_RETRY_DELAY_MS).toBe(15_000);
  });
});

// ---------------------------------------------------------------------------
// failure-classification.ts — deriveFailureSignature (CB-1, AC 2)
// ---------------------------------------------------------------------------

describe("deriveFailureSignature (CB-1)", () => {
  describe("named signature classes (cosmetic differences cannot defeat a match)", () => {
    it("stdin-wait warning is its own class (absorbs early-exit-on-stdin-warning, AC 2)", () => {
      const warning =
        "Input must be provided either through stdin or as a prompt argument when using --print";
      expect(deriveFailureSignature(warning)).toBe("stdin-wait-warning");
      // case-insensitive substring match
      expect(deriveFailureSignature(`Error: ${warning.toUpperCase()}`)).toBe("stdin-wait-warning");
    });

    it("idle-kill messages share one class regardless of duration", () => {
      const a = deriveFailureSignature("agent idle-killed after 300000ms with no stdout output");
      const b = deriveFailureSignature("agent idle-killed after 1800000ms with no stdout output");
      expect(a).toBe("idle-timeout");
      expect(b).toBe(a);
    });

    it("ceiling-kill messages map to hard-ceiling", () => {
      expect(
        deriveFailureSignature(
          "agent killed at hard ceiling 3600000ms (still streaming — absolute runtime limit)"
        )
      ).toBe("hard-ceiling");
    });

    it("legacy wall-clock timeout messages map to wall-clock-timeout (mixed-version resumes)", () => {
      expect(deriveFailureSignature("agent timed out after 900000ms")).toBe("wall-clock-timeout");
    });

    it("buffer overflow maps to buffer-overflow", () => {
      expect(deriveFailureSignature("agent output exceeded 10MB buffer")).toBe("buffer-overflow");
    });

    it("empty-output sentinel maps to no-output", () => {
      expect(deriveFailureSignature("agent produced no output")).toBe("no-output");
    });

    it("missing-outputs carries the sorted pattern list: missing A != missing B, missing A twice matches", () => {
      const missingA =
        "Agent completed (exit 0) but did not create required output files: tests/bdd/*.feature. The step is not complete until these files exist on disk.";
      const missingB =
        "Agent completed (exit 0) but did not create required output files: tests/integration/*. The step is not complete until these files exist on disk.";
      const sigA1 = deriveFailureSignature(missingA);
      const sigA2 = deriveFailureSignature(missingA);
      const sigB = deriveFailureSignature(missingB);
      expect(sigA1).toBe(sigA2);
      expect(sigA1).not.toBe(sigB);
      expect(sigA1.startsWith("missing-outputs:")).toBe(true);
    });

    it("missing-outputs sorts the pattern list so ordering differences still match", () => {
      const ab =
        "Agent completed (exit 0) but did not create required output files: tests/bdd/*.feature, tests/integration/*. The step is not complete until these files exist on disk.";
      const ba =
        "Agent completed (exit 0) but did not create required output files: tests/integration/*, tests/bdd/*.feature. The step is not complete until these files exist on disk.";
      expect(deriveFailureSignature(ab)).toBe(deriveFailureSignature(ba));
    });

    it("missing-artifacts gets the same sorted-list treatment", () => {
      const sig = deriveFailureSignature(
        "Missing required artifacts: docs/architecture/progress-aware-circuit-breaker.md"
      );
      expect(sig.startsWith("missing-artifacts:")).toBe(true);
      expect(sig).not.toBe(
        deriveFailureSignature("Missing required artifacts: docs/specs/other.md")
      );
    });
  });

  describe("generic normalization fallback", () => {
    it("is deterministic: same text always derives the same signature", () => {
      const msg = "SyntaxError: unexpected token in src/orchestrator/runner.ts";
      expect(deriveFailureSignature(msg)).toBe(deriveFailureSignature(msg));
    });

    it("strips durations so retry-varying timings still match", () => {
      expect(deriveFailureSignature("compile failed after 120ms in module X")).toBe(
        deriveFailureSignature("compile failed after 4500ms in module X")
      );
    });

    it("strips ISO-8601 timestamps", () => {
      expect(
        deriveFailureSignature("build failed at 2026-07-06T10:15:00.000Z: bad import")
      ).toBe(deriveFailureSignature("build failed at 2026-07-06T11:59:59.999Z: bad import"));
    });

    it("normalizes $HOME-anchored absolute paths", () => {
      const home = os.homedir();
      expect(
        deriveFailureSignature(`cannot open ${home}/workspace/proj-a/file.ts`)
      ).toBe(deriveFailureSignature(`cannot open ${home}/workspace/proj-a/file.ts`));
      // Different content after normalization must still differ
      expect(deriveFailureSignature("cannot open fileA")).not.toBe(
        deriveFailureSignature("totally different failure mode")
      );
    });

    it("bounds the signature to a readable prefix (<= 200 chars, not a hash)", () => {
      const long = "x".repeat(1000);
      const sig = deriveFailureSignature(`failure: ${long}`);
      expect(sig.length).toBeLessThanOrEqual(200);
      expect(sig).toContain("failure");
    });
  });
});

// ---------------------------------------------------------------------------
// runner.ts — decideAfterFailure pipeline (CB-1/CB-2/CB-4 ordering)
// ---------------------------------------------------------------------------

describe("decideAfterFailure — decision pipeline", () => {
  describe("ordering: salvage-complete beats everything (CB-4, AC 15)", () => {
    it("returns salvage-complete when all expected outputs pass the gate — Sprint 11 replay", () => {
      const state = stepStateWith([detFailure("idle-timeout")]);
      const salvage = {
        complete: true,
        satisfied: ["tests/bdd/*.feature", "tests/integration/*"],
        missing: [],
      };
      const decision = decideAfterFailure(state, lastFailure(state), salvage);
      expect(decision.kind).toBe("salvage-complete");
    });

    it("salvage-complete wins even when the failure is transient AND at the transient cap AND signatures repeat", () => {
      const failures = [
        ...Array.from({ length: TRANSIENT_RETRY_CAP - 1 }, () => transFailure("socket-drop")),
        transFailure("socket-drop"),
      ];
      const state = stepStateWith(failures);
      const salvage = { complete: true, satisfied: ["tests/bdd/*.feature"], missing: [] };
      const decision = decideAfterFailure(state, lastFailure(state), salvage);
      expect(decision.kind).toBe("salvage-complete");
    });
  });

  describe("transient handling (CB-2, AC 6-7)", () => {
    it("transient failure retries WITHOUT consuming a slot, with the fixed delay", () => {
      const state = stepStateWith([transFailure("socket-drop")], 0);
      const decision = decideAfterFailure(state, lastFailure(state), NO_SALVAGE);
      expect(decision).toEqual(
        expect.objectContaining({ kind: "retry", consumesSlot: false, delayMs: TRANSIENT_RETRY_DELAY_MS })
      );
    });

    it("two identical consecutive transient failures retry (CB-2 governs, not CB-1)", () => {
      const state = stepStateWith(
        [transFailure("socket-drop"), transFailure("socket-drop")],
        0
      );
      const decision = decideAfterFailure(state, lastFailure(state), NO_SALVAGE);
      expect(decision.kind).toBe("retry");
      expect((decision as Extract<RetryDecision, { kind: "retry" }>).consumesSlot).toBe(false);
    });

    it("escalates with transient-cap on the 5th transient failure", () => {
      const failures = Array.from({ length: TRANSIENT_RETRY_CAP }, () =>
        transFailure("socket-drop")
      );
      const state = stepStateWith(failures, 0);
      const decision = decideAfterFailure(state, lastFailure(state), NO_SALVAGE);
      expect(decision.kind).toBe("escalate");
      const esc = decision as Extract<RetryDecision, { kind: "escalate" }>;
      expect(esc.reason).toBe("transient-cap");
      // Message contract: identifies the persistent infrastructure problem
      expect(esc.detail.toLowerCase()).toContain("infrastructure");
    });

    it("transient failures never increment the deterministic attempt count (derived, not stored)", () => {
      // 4 transients + 1 deterministic: attempts (deterministic meaning) is 1
      const failures = [
        transFailure("socket-drop"),
        transFailure("socket-drop"),
        transFailure("socket-drop"),
        transFailure("socket-drop"),
        detFailure("no-output"),
      ];
      const state = stepStateWith(failures);
      expect(state.attempts).toBe(1);
      const decision = decideAfterFailure(state, lastFailure(state), NO_SALVAGE);
      // First deterministic failure, unique signature → normal slot-consuming retry
      expect(decision).toEqual(
        expect.objectContaining({ kind: "retry", consumesSlot: true })
      );
    });
  });

  describe("no-progress short-circuit (CB-1, AC 1-4)", () => {
    it("escalates no-progress on two consecutive identical deterministic signatures", () => {
      const state = stepStateWith([detFailure("no-output"), detFailure("no-output")]);
      const decision = decideAfterFailure(state, lastFailure(state), NO_SALVAGE);
      expect(decision.kind).toBe("escalate");
      const esc = decision as Extract<RetryDecision, { kind: "escalate" }>;
      expect(esc.reason).toBe("no-progress");
      // Message contract: states the short-circuit and shows the repeated signature
      expect(esc.detail).toContain("short-circuit");
      expect(esc.detail).toContain("no-output");
    });

    it("two stdin-wait warnings short-circuit after 2 attempts (AC 2)", () => {
      const state = stepStateWith([
        detFailure("stdin-wait-warning"),
        detFailure("stdin-wait-warning"),
      ]);
      const decision = decideAfterFailure(state, lastFailure(state), NO_SALVAGE);
      expect(decision.kind).toBe("escalate");
      expect((decision as Extract<RetryDecision, { kind: "escalate" }>).reason).toBe("no-progress");
    });

    it("different signatures do NOT short-circuit (AC 3)", () => {
      const state = stepStateWith([detFailure("no-output"), detFailure("buffer-overflow")]);
      const decision = decideAfterFailure(state, lastFailure(state), NO_SALVAGE);
      expect(decision).toEqual(
        expect.objectContaining({ kind: "retry", consumesSlot: true })
      );
    });

    it("det(A) → transient → det(A) still short-circuits: comparison skips transient records", () => {
      const state = stepStateWith([
        detFailure("no-output"),
        transFailure("socket-drop"),
        detFailure("no-output"),
      ]);
      const decision = decideAfterFailure(state, lastFailure(state), NO_SALVAGE);
      expect(decision.kind).toBe("escalate");
      expect((decision as Extract<RetryDecision, { kind: "escalate" }>).reason).toBe("no-progress");
    });

    it("identical signature across a narrowing boundary does NOT short-circuit", () => {
      const state = stepStateWith([
        detFailure("no-output"), // full-scope attempt
        detFailure("no-output", { narrowed: true } as Partial<FailureRecord>), // narrowed attempt
      ]);
      const decision = decideAfterFailure(state, lastFailure(state), NO_SALVAGE);
      expect(decision.kind).not.toBe("escalate");
    });

    it("an old record with no persisted signature never matches (treat as no-match, never re-derive)", () => {
      // Legacy record: same errorSummary text, but no signature field
      const legacy = failure({ errorSummary: "agent produced no output" });
      const state = stepStateWith([legacy, detFailure("no-output")]);
      const decision = decideAfterFailure(state, lastFailure(state), NO_SALVAGE);
      expect(decision.kind).not.toBe("escalate");
    });
  });

  describe("deterministic slot accounting (AC 8) — today's behavior preserved", () => {
    it("first and second deterministic failures (distinct signatures) retry and consume a slot", () => {
      const one = stepStateWith([detFailure("sig-1")]);
      expect(decideAfterFailure(one, lastFailure(one), NO_SALVAGE)).toEqual(
        expect.objectContaining({ kind: "retry", consumesSlot: true })
      );

      const two = stepStateWith([detFailure("sig-1"), detFailure("sig-2")]);
      expect(decideAfterFailure(two, lastFailure(two), NO_SALVAGE)).toEqual(
        expect.objectContaining({ kind: "retry", consumesSlot: true })
      );
    });

    it("escalates attempts-exhausted after MAX_RETRY_ATTEMPTS deterministic failures with distinct signatures", () => {
      const failures = Array.from({ length: MAX_RETRY_ATTEMPTS }, (_, i) =>
        detFailure(`sig-${i}`)
      );
      const state = stepStateWith(failures);
      const decision = decideAfterFailure(state, lastFailure(state), NO_SALVAGE);
      expect(decision.kind).toBe("escalate");
      expect((decision as Extract<RetryDecision, { kind: "escalate" }>).reason).toBe(
        "attempts-exhausted"
      );
    });

    it("MAX_RETRY_ATTEMPTS itself is unchanged (still 3, not user-configurable)", () => {
      expect(MAX_RETRY_ATTEMPTS).toBe(3);
    });
  });

  describe("single- vs multi-feature parity (spec edge case)", () => {
    it("is a pure function: identical inputs produce identical decisions (the shared mechanism both loops call)", () => {
      const mk = () => stepStateWith([detFailure("no-output"), detFailure("no-output")]);
      const a = decideAfterFailure(mk(), lastFailure(mk()), { ...NO_SALVAGE, satisfied: [], missing: [...NO_SALVAGE.missing] });
      const b = decideAfterFailure(mk(), lastFailure(mk()), { ...NO_SALVAGE, satisfied: [], missing: [...NO_SALVAGE.missing] });
      expect(a).toEqual(b);
    });
  });
});

// ---------------------------------------------------------------------------
// runner.ts — checkSalvage against a real filesystem (CB-4, AC 15-17)
// ---------------------------------------------------------------------------

describe("checkSalvage — real filesystem (CB-4)", () => {
  let projectDir: string;
  const step3: WorkflowStep = SPRINT_WORKFLOW.find((s) => s.step === 3)!;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacb-salvage-"));
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  function write(rel: string, content = "// salvaged\n"): void {
    const full = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it("reports complete when every expected-output pattern is satisfied by real slug-named files", () => {
    write(`tests/bdd/${SLUG}.feature`);
    write(`tests/integration/${SLUG}.integration.test.ts`);
    const result = checkSalvage(step3, SLUG, projectDir);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.satisfied.length).toBe(step3.expectedOutputs.length);
  });

  it("reports partial: satisfied and missing lists identify exactly which patterns are which (feeds AC 14)", () => {
    write(`tests/bdd/${SLUG}.feature`);
    const result = checkSalvage(step3, SLUG, projectDir);
    expect(result.complete).toBe(false);
    expect(result.satisfied.join(",")).toContain("tests/bdd/*.feature");
    expect(result.missing.join(",")).toContain("tests/integration/*");
  });

  it("never bypasses validation: files that fail the glob gate (wrong slug) do not satisfy (AC 16)", () => {
    write("tests/bdd/some-other-feature.feature");
    write("tests/integration/some-other-feature.integration.test.ts");
    const result = checkSalvage(step3, SLUG, projectDir);
    expect(result.complete).toBe(false);
  });

  it(".gitkeep-only directories never count as salvageable artifacts (AC 17)", () => {
    write(`tests/bdd/${SLUG}/.gitkeep`, "");
    write(`tests/integration/${SLUG}/.gitkeep`, "");
    const result = checkSalvage(step3, SLUG, projectDir);
    expect(result.complete).toBe(false);
    expect(result.satisfied).toEqual([]);
  });

  it("a directory at the literal expected path does not satisfy (the Sprint 8 EISDIR regression class)", () => {
    fs.mkdirSync(path.join(projectDir, `tests/integration/${SLUG}`), { recursive: true });
    fs.mkdirSync(path.join(projectDir, "tests/bdd"), { recursive: true });
    const result = checkSalvage(step3, SLUG, projectDir);
    expect(result.complete).toBe(false);
  });

  it("does not cache between calls: a file written after a failed attempt is seen by the next check (tree-preservation invariant)", () => {
    const before = checkSalvage(step3, SLUG, projectDir);
    expect(before.complete).toBe(false);
    // attempt N writes its outputs to the working tree, uncommitted...
    write(`tests/bdd/${SLUG}.feature`);
    write(`tests/integration/${SLUG}.integration.test.ts`);
    // ...and attempt N+1's salvage check must see them
    const after = checkSalvage(step3, SLUG, projectDir);
    expect(after.complete).toBe(true);
  });

  it("is read-only: checking salvage never mutates the tree", () => {
    write(`tests/bdd/${SLUG}.feature`, "original");
    checkSalvage(step3, SLUG, projectDir);
    expect(fs.readFileSync(path.join(projectDir, `tests/bdd/${SLUG}.feature`), "utf-8")).toBe(
      "original"
    );
  });
});

// ---------------------------------------------------------------------------
// timeouts.ts — hard ceiling constant (CB-3, AC 12)
// ---------------------------------------------------------------------------

describe("hard ceiling (CB-3)", () => {
  it("HARD_CEILING_MS is 60 minutes (Architect ruling, Open Question 3)", () => {
    expect(HARD_CEILING_MS).toBe(60 * 60 * 1000);
  });

  it("ceiling >= MAX_TIMEOUT_MS, and MAX_TIMEOUT_MS is NOT raised (stays 30 min)", () => {
    expect(HARD_CEILING_MS).toBeGreaterThanOrEqual(MAX_TIMEOUT_MS);
    expect(MAX_TIMEOUT_MS).toBe(30 * 60 * 1000);
  });

  it("AgentResult accepts the additive killKind field (compile-time contract)", () => {
    const idle: AgentResult = { output: "x", exitCode: 1, killKind: "idle" };
    const ceiling: AgentResult = { output: "x", exitCode: 1, killKind: "ceiling" };
    const legacy: AgentResult = { output: "x", exitCode: 0 }; // killKind optional — additive
    expect(idle.killKind).toBe("idle");
    expect(ceiling.killKind).toBe("ceiling");
    expect(legacy.killKind).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// config.ts + timeouts.ts — timeout config plumbing (CB-5, AC 18-20)
// ---------------------------------------------------------------------------

describe("timeout config plumbing (CB-5)", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pacb-config-"));
    configPath = path.join(tmpDir, "config.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadConfig parses timeouts.default and timeouts.stepOverrides (AC 19)", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        projectsBaseDir: tmpDir,
        timeouts: {
          default: 420000,
          stepOverrides: { "Author specification": 120000 },
        },
      })
    );
    const config = loadConfig(configPath);
    expect(config.timeouts).toEqual({
      default: 420000,
      stepOverrides: { "Author specification": 120000 },
    });
  });

  it("absent timeouts key → field absent → byte-identical behavior (AC 19)", () => {
    fs.writeFileSync(configPath, JSON.stringify({ projectsBaseDir: tmpDir }));
    const config = loadConfig(configPath);
    expect(config.timeouts).toBeUndefined();
    // resolution with no config matches today's built-in behavior exactly
    expect(resolveStepTimeout("Write tests", config.timeouts)).toBe(30 * 60 * 1000);
    expect(resolveStepTimeout("Open PR", config.timeouts)).toBe(5 * 60 * 1000);
  });

  it("missing config file still yields defaults with no timeouts field", () => {
    const config = loadConfig(path.join(tmpDir, "does-not-exist.json"));
    expect(config.timeouts).toBeUndefined();
  });

  it("non-number override values are dropped field-wise, malformed timeouts ignored entirely", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        timeouts: {
          default: "fast", // not a number → dropped
          stepOverrides: { "Write tests": 600000, Demo: "long" }, // Demo dropped
        },
      })
    );
    const config = loadConfig(configPath);
    expect(config.timeouts?.default).toBeUndefined();
    expect(config.timeouts?.stepOverrides?.["Write tests"]).toBe(600000);
    expect(config.timeouts?.stepOverrides?.["Demo"]).toBeUndefined();

    fs.writeFileSync(configPath, JSON.stringify({ timeouts: "yes please" }));
    const malformed = loadConfig(configPath);
    expect(malformed.timeouts).toBeUndefined();
  });

  it("end-to-end (AC 20): a config.json step override changes the timeout applied to that step", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        timeouts: { stepOverrides: { "Author specification": 120000 } },
      })
    );
    const config = loadConfig(configPath);
    // The value the runner call sites (runner.ts:831,855,1445,1467) must now
    // pass through — and hand to spawnAgent as the idle window.
    const applied = resolveStepTimeout("Author specification", config.timeouts);
    expect(applied).toBe(120000);
    // Without the config, that step resolves to the 5-min global default
    expect(resolveStepTimeout("Author specification")).toBe(300000);
  });

  it("resolution order is unchanged: override > default > built-in > fallback", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        timeouts: { default: 420000, stepOverrides: { "Write tests": 600000 } },
      })
    );
    const { timeouts } = loadConfig(configPath);
    expect(resolveStepTimeout("Write tests", timeouts)).toBe(600000); // override wins
    expect(resolveStepTimeout("Open PR", timeouts)).toBe(420000); // default beats fallback
    expect(resolveStepTimeout("Write tests", { default: 420000 })).toBe(420000); // default beats built-in
  });
});

// ---------------------------------------------------------------------------
// state.ts — backward compatibility (AC 9, AC 21)
// ---------------------------------------------------------------------------

describe("sprint-state backward compatibility (AC 9, AC 21)", () => {
  let tmpHome: string;
  let homedirSpy: jest.SpyInstance;
  const projectSlug = "pacb-compat-test";

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pacb-home-"));
    homedirSpy = jest.spyOn(os, "homedir").mockReturnValue(tmpHome);
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeLegacyState(): void {
    const stateDir = path.join(tmpHome, ".raptor", projectSlug);
    fs.mkdirSync(stateDir, { recursive: true });
    // A pre-Sprint-12 state file: failures have NO classification, signature,
    // killKind, narrowed, or salvagedPatterns; steps have no completedVia or
    // escalationReason.
    const legacyState = {
      project: projectSlug,
      sprint: 11,
      status: "escalated",
      currentStep: 3,
      branchName: "sprint-11/some-feature",
      steps: [
        {
          step: 3,
          role: "qa",
          name: "Write tests",
          status: "escalated",
          artifacts: [],
          completedAt: null,
          attempts: 3,
          failures: [
            {
              attempt: 1,
              errorSummary: "agent timed out after 900000ms",
              timestamp: "2026-06-30T10:00:00.000Z",
              hadPartialArtifacts: true,
            },
            {
              attempt: 2,
              errorSummary: "socket connection closed unexpectedly",
              timestamp: "2026-06-30T10:20:00.000Z",
              hadPartialArtifacts: true,
            },
            {
              attempt: 3,
              errorSummary: "socket connection closed unexpectedly",
              timestamp: "2026-06-30T10:40:00.000Z",
              hadPartialArtifacts: true,
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
    fs.writeFileSync(path.join(stateDir, "sprint-11.json"), JSON.stringify(legacyState));
  }

  it("loads a pre-Sprint-12 state file without error", () => {
    writeLegacyState();
    const state = loadSprintState(projectSlug, 11);
    expect(state).not.toBeNull();
    expect(state!.steps[0].failures).toHaveLength(3);
  });

  it("unclassified legacy failure records read as deterministic via the ?? convention (AC 9)", () => {
    writeLegacyState();
    const state = loadSprintState(projectSlug, 11)!;
    for (const f of state.steps[0].failures) {
      const classification =
        (f as FailureRecord & { classification?: string }).classification ?? "deterministic";
      expect(classification).toBe("deterministic");
    }
  });

  it("new optional step fields read with backward-compatible defaults (AC 21)", () => {
    writeLegacyState();
    const state = loadSprintState(projectSlug, 11)!;
    const step = state.steps[0] as StepState & {
      completedVia?: string;
      escalationReason?: string;
    };
    expect(step.completedVia ?? "agent").toBe("agent");
    expect(step.escalationReason).toBeUndefined();
    // attempts keeps its frozen meaning: deterministic attempts consumed
    expect(step.attempts).toBe(3);
  });
});
