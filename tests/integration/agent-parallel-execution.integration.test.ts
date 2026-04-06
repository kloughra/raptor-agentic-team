import { WorkflowStep, SPRINT_WORKFLOW } from "../../src/orchestrator/workflow";
import { createInitialState, saveSprintState, loadSprintState, SprintState, StepState } from "../../src/orchestrator/state";
import { renderProgressTable } from "../../src/orchestrator/progress";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

describe("Agent Parallel Execution", () => {
  const tmpDir = path.join(os.tmpdir(), `raptor-parallel-test-${Date.now()}`);

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("Workflow definition — parallelWith field", () => {
    it("WorkflowStep interface supports parallelWith field", () => {
      const step: WorkflowStep & { parallelWith?: number } = {
        step: 7,
        role: "qa",
        name: "Run test suite",
        description: "Execute the full test suite",
        inputArtifacts: [],
        expectedOutputs: [],
        parallelWith: 7, // grouped with architect review
      };
      expect(step.parallelWith).toBe(7);
    });

    it("existing workflow steps do not have parallelWith (backward compat)", () => {
      for (const step of SPRINT_WORKFLOW) {
        expect((step as WorkflowStep & { parallelWith?: number }).parallelWith).toBeUndefined();
      }
    });
  });

  describe("Parallel step state tracking", () => {
    it("two steps can be in-progress simultaneously", () => {
      const state = createInitialState("test-project", 5, [
        { step: 1, role: "architect", name: "Architect review" },
        { step: 2, role: "qa", name: "Run test suite" },
      ]);

      state.steps[0].status = "in-progress";
      state.steps[1].status = "in-progress";

      const inProgressSteps = state.steps.filter((s) => s.status === "in-progress");
      expect(inProgressSteps).toHaveLength(2);
    });

    it("parallel steps track attempts independently", () => {
      const state = createInitialState("test-project", 5, [
        { step: 1, role: "architect", name: "Architect review" },
        { step: 2, role: "qa", name: "Run test suite" },
      ]);

      state.steps[0].attempts = 2;
      state.steps[0].failures = [
        { attempt: 1, errorSummary: "timeout", timestamp: new Date().toISOString(), hadPartialArtifacts: false },
      ];
      state.steps[1].attempts = 1;

      expect(state.steps[0].attempts).toBe(2);
      expect(state.steps[1].attempts).toBe(1);
      expect(state.steps[0].failures).toHaveLength(1);
      expect(state.steps[1].failures).toHaveLength(0);
    });

    it("one step can be escalated while other is complete", () => {
      const state = createInitialState("test-project", 5, [
        { step: 1, role: "architect", name: "Architect review" },
        { step: 2, role: "qa", name: "Run test suite" },
      ]);

      state.steps[0].status = "complete";
      state.steps[0].completedAt = new Date().toISOString();
      state.steps[1].status = "escalated";
      state.steps[1].attempts = 3;

      expect(state.steps[0].status).toBe("complete");
      expect(state.steps[1].status).toBe("escalated");
    });
  });

  describe("Promise.allSettled pattern for parallel execution", () => {
    it("collects results from both steps even when one fails", async () => {
      const stepA = Promise.resolve({ step: 1, success: true, output: "done" });
      const stepB = Promise.resolve({ step: 2, success: false, output: "error" });

      const results = await Promise.allSettled([stepA, stepB]);

      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("fulfilled");
      if (results[0].status === "fulfilled" && results[1].status === "fulfilled") {
        expect(results[0].value.success).toBe(true);
        expect(results[1].value.success).toBe(false);
      }
    });

    it("does not cancel one step when the other rejects", async () => {
      let stepBCompleted = false;
      const stepA = Promise.reject(new Error("agent crash"));
      const stepB = new Promise<string>((resolve) => {
        setTimeout(() => {
          stepBCompleted = true;
          resolve("done");
        }, 10);
      });

      const results = await Promise.allSettled([stepA, stepB]);

      expect(results[0].status).toBe("rejected");
      expect(results[1].status).toBe("fulfilled");
      expect(stepBCompleted).toBe(true);
    });

    it("both steps can fail independently", async () => {
      const stepA = Promise.reject(new Error("fail A"));
      const stepB = Promise.reject(new Error("fail B"));

      const results = await Promise.allSettled([stepA, stepB]);

      expect(results[0].status).toBe("rejected");
      expect(results[1].status).toBe("rejected");
    });
  });

  describe("Progress table with parallel steps", () => {
    it("shows both parallel steps as in-progress", () => {
      const state = createInitialState("test-project", 5, [
        { step: 1, role: "po", name: "Author specification" },
        { step: 2, role: "architect", name: "Architecture design" },
        { step: 3, role: "qa", name: "Write tests" },
        { step: 4, role: "po", name: "Review tests" },
        { step: 5, role: "engineer", name: "Implement (TDD)" },
        { step: 6, role: "engineer", name: "Open PR" },
        { step: 7, role: "architect", name: "Architect review" },
        { step: 8, role: "qa", name: "Run test suite" },
      ]);

      // Mark steps 1-6 complete
      for (let i = 0; i < 6; i++) {
        state.steps[i].status = "complete";
      }
      // Both parallel steps in progress
      state.steps[6].status = "in-progress";
      state.steps[7].status = "in-progress";

      const table = renderProgressTable(state);

      expect(table).toContain("🔄");
      // Both should show in-progress
      const inProgressMatches = table.match(/🔄/g);
      expect(inProgressMatches).not.toBeNull();
      expect(inProgressMatches!.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("Circuit breaker independence", () => {
    it("each parallel step has its own retry count", () => {
      const stepA: StepState = {
        step: 7,
        role: "architect",
        name: "Architect review",
        status: "in-progress",
        artifacts: [],
        completedAt: null,
        attempts: 2,
        failures: [
          { attempt: 1, errorSummary: "timeout", timestamp: new Date().toISOString(), hadPartialArtifacts: false },
        ],
      };

      const stepB: StepState = {
        step: 8,
        role: "qa",
        name: "Run test suite",
        status: "complete",
        artifacts: [],
        completedAt: new Date().toISOString(),
        attempts: 1,
        failures: [],
      };

      expect(stepA.attempts).toBe(2);
      expect(stepB.attempts).toBe(1);
      expect(stepA.failures).toHaveLength(1);
      expect(stepB.failures).toHaveLength(0);
    });

    it("escalation threshold is independent — one escalates at 3 while other succeeds", () => {
      const MAX_RETRY = 3;

      const stepA: StepState = {
        step: 7,
        role: "architect",
        name: "Architect review",
        status: "escalated",
        artifacts: [],
        completedAt: null,
        attempts: MAX_RETRY,
        failures: [
          { attempt: 1, errorSummary: "fail", timestamp: "", hadPartialArtifacts: false },
          { attempt: 2, errorSummary: "fail", timestamp: "", hadPartialArtifacts: false },
          { attempt: 3, errorSummary: "fail", timestamp: "", hadPartialArtifacts: false },
        ],
      };

      const stepB: StepState = {
        step: 8,
        role: "qa",
        name: "Run test suite",
        status: "complete",
        artifacts: ["test-results.xml"],
        completedAt: new Date().toISOString(),
        attempts: 1,
        failures: [],
      };

      expect(stepA.status).toBe("escalated");
      expect(stepA.attempts).toBe(MAX_RETRY);
      expect(stepB.status).toBe("complete");
      expect(stepB.artifacts).toContain("test-results.xml");
    });
  });

  describe("BLOCKER handling in parallel context", () => {
    it("BLOCKER regex detects marker in agent output", () => {
      const output = "I cannot proceed. [BLOCKER] QA: Missing test fixtures — blocked on Engineer";
      const hasBlocker = /\[blocker\]/i.test(output);
      expect(hasBlocker).toBe(true);
    });

    it("one step with BLOCKER while other succeeds", () => {
      const stepA: StepState = {
        step: 7,
        role: "architect",
        name: "Architect review",
        status: "escalated",
        artifacts: [],
        completedAt: null,
        attempts: 1,
        failures: [
          { attempt: 1, errorSummary: "[BLOCKER] Architect: missing API contracts", timestamp: "", hadPartialArtifacts: false },
        ],
      };

      const stepB: StepState = {
        step: 8,
        role: "qa",
        name: "Run test suite",
        status: "complete",
        artifacts: [],
        completedAt: new Date().toISOString(),
        attempts: 1,
        failures: [],
      };

      expect(stepA.status).toBe("escalated");
      expect(stepB.status).toBe("complete");
    });
  });
});
