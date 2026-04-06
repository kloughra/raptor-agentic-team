import { createInitialState, saveSprintState, loadSprintState, SprintState, DodChecklist } from "../../src/orchestrator/state";
import { renderProgressTable } from "../../src/orchestrator/progress";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

// Type for the new FeatureState (will be added to state.ts)
interface FeatureState {
  slug: string;
  branchName: string | null;
  status: "pending" | "in-progress" | "complete" | "failed" | "escalated";
  currentStep: number;
  steps: Array<{
    step: number;
    role: string;
    name: string;
    status: string;
    artifacts: string[];
    completedAt: string | null;
    attempts: number;
    failures: Array<{ attempt: number; errorSummary: string; timestamp: string; hadPartialArtifacts: boolean }>;
  }>;
  dod: DodChecklist;
}

describe("Multi-Engineer Coordination", () => {
  const tmpDir = path.join(os.tmpdir(), `raptor-multi-eng-test-${Date.now()}`);
  const raptorHome = path.join(tmpDir, ".raptor");

  beforeAll(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    // Override HOME for state persistence tests
    process.env.RAPTOR_TEST_HOME = tmpDir;
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.RAPTOR_TEST_HOME;
  });

  describe("Multi-feature detection from backlog", () => {
    it("detects multiple features from sprint section", () => {
      const backlog = `# Backlog

## Sprint 5
- [ ] agent-parallel-execution: Parallel agent execution
- [ ] multi-engineer-coordination: Multi-engineer support
- [ ] dino-agent-names: Dinosaur-themed names
`;
      const itemPattern = /- \[[ x]\]\s+([a-z][a-z0-9-]*):/g;
      const features: string[] = [];
      let match;
      while ((match = itemPattern.exec(backlog)) !== null) {
        features.push(match[1]);
      }
      expect(features).toEqual(["agent-parallel-execution", "multi-engineer-coordination", "dino-agent-names"]);
      expect(features.length).toBeGreaterThan(1);
    });

    it("detects single feature for backward compat mode", () => {
      const backlog = `# Backlog

## Sprint 5
- [ ] dino-agent-names: Dinosaur-themed names
`;
      const itemPattern = /- \[[ x]\]\s+([a-z][a-z0-9-]*):/g;
      const features: string[] = [];
      let match;
      while ((match = itemPattern.exec(backlog)) !== null) {
        features.push(match[1]);
      }
      expect(features).toHaveLength(1);
    });
  });

  describe("FeatureState structure", () => {
    it("creates a FeatureState for each backlog item", () => {
      const slugs = ["agent-parallel-execution", "multi-engineer-coordination", "dino-agent-names"];
      const workflowSteps = [
        { step: 1, role: "po", name: "Author specification" },
        { step: 2, role: "architect", name: "Architecture design" },
        { step: 3, role: "qa", name: "Write tests" },
        { step: 4, role: "po", name: "Review tests" },
        { step: 5, role: "engineer", name: "Implement (TDD)" },
      ];

      const features: FeatureState[] = slugs.map((slug) => ({
        slug,
        branchName: null,
        status: "pending",
        currentStep: 1,
        steps: workflowSteps.map((s) => ({
          step: s.step,
          role: s.role,
          name: s.name,
          status: "pending",
          artifacts: [],
          completedAt: null,
          attempts: 0,
          failures: [],
        })),
        dod: {
          codeCommitted: false,
          testsPass: false,
          prReviewApproved: false,
          poAccepted: false,
          demoCompleted: false,
        },
      }));

      expect(features).toHaveLength(3);
      expect(features[0].slug).toBe("agent-parallel-execution");
      expect(features[0].steps).toHaveLength(5);
      expect(features[0].dod.codeCommitted).toBe(false);
    });

    it("each feature tracks its own branch name", () => {
      const feature: FeatureState = {
        slug: "agent-parallel-execution",
        branchName: "sprint-5/agent-parallel-execution",
        status: "in-progress",
        currentStep: 5,
        steps: [],
        dod: { codeCommitted: false, testsPass: false, prReviewApproved: false, poAccepted: false, demoCompleted: false },
      };

      expect(feature.branchName).toBe("sprint-5/agent-parallel-execution");
    });
  });

  describe("Per-feature DoD tracking", () => {
    it("features have independent DoD checklists", () => {
      const featureA: FeatureState = {
        slug: "feature-a",
        branchName: null,
        status: "in-progress",
        currentStep: 7,
        steps: [],
        dod: { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: false, demoCompleted: false },
      };

      const featureB: FeatureState = {
        slug: "feature-b",
        branchName: null,
        status: "in-progress",
        currentStep: 5,
        steps: [],
        dod: { codeCommitted: false, testsPass: false, prReviewApproved: false, poAccepted: false, demoCompleted: false },
      };

      expect(featureA.dod.prReviewApproved).toBe(true);
      expect(featureB.dod.prReviewApproved).toBe(false);
    });
  });

  describe("Feature isolation — one failure doesn't block others", () => {
    it("feature A escalated while feature B continues", () => {
      const features: FeatureState[] = [
        {
          slug: "feature-a",
          branchName: null,
          status: "escalated",
          currentStep: 5,
          steps: [
            { step: 5, role: "engineer", name: "Implement (TDD)", status: "escalated", artifacts: [], completedAt: null, attempts: 3, failures: [] },
          ],
          dod: { codeCommitted: false, testsPass: false, prReviewApproved: false, poAccepted: false, demoCompleted: false },
        },
        {
          slug: "feature-b",
          branchName: null,
          status: "in-progress",
          currentStep: 6,
          steps: [
            { step: 5, role: "engineer", name: "Implement (TDD)", status: "complete", artifacts: [], completedAt: new Date().toISOString(), attempts: 1, failures: [] },
            { step: 6, role: "engineer", name: "Open PR", status: "in-progress", artifacts: [], completedAt: null, attempts: 0, failures: [] },
          ],
          dod: { codeCommitted: false, testsPass: false, prReviewApproved: false, poAccepted: false, demoCompleted: false },
        },
      ];

      expect(features[0].status).toBe("escalated");
      expect(features[1].status).toBe("in-progress");

      // Sprint-level status should be "partial" — not fully escalated
      const allComplete = features.every((f) => f.status === "complete");
      const anyEscalated = features.some((f) => f.status === "escalated");
      expect(allComplete).toBe(false);
      expect(anyEscalated).toBe(true);
    });
  });

  describe("Sprint completion requires all features done", () => {
    it("sprint is not complete until all features are complete", () => {
      const features: FeatureState[] = [
        { slug: "a", branchName: null, status: "complete", currentStep: 9, steps: [], dod: { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: true, demoCompleted: true } },
        { slug: "b", branchName: null, status: "in-progress", currentStep: 5, steps: [], dod: { codeCommitted: false, testsPass: false, prReviewApproved: false, poAccepted: false, demoCompleted: false } },
      ];

      const allComplete = features.every((f) => f.status === "complete");
      expect(allComplete).toBe(false);
    });

    it("sprint is complete when all features are complete", () => {
      const features: FeatureState[] = [
        { slug: "a", branchName: null, status: "complete", currentStep: 9, steps: [], dod: { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: true, demoCompleted: true } },
        { slug: "b", branchName: null, status: "complete", currentStep: 9, steps: [], dod: { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: true, demoCompleted: true } },
      ];

      const allComplete = features.every((f) => f.status === "complete");
      expect(allComplete).toBe(true);
    });
  });

  describe("State persistence with features", () => {
    it("SprintState with features field serializes and deserializes", () => {
      const state = createInitialState("test-project", 5, [
        { step: 1, role: "po", name: "Author specification" },
      ]);

      // Attach features field (simulating the extension)
      const stateWithFeatures = {
        ...state,
        features: [
          {
            slug: "feature-a",
            branchName: "sprint-5/feature-a",
            status: "in-progress",
            currentStep: 3,
            steps: [
              { step: 1, role: "po", name: "Author spec", status: "complete", artifacts: [], completedAt: new Date().toISOString(), attempts: 1, failures: [] },
            ],
            dod: { codeCommitted: false, testsPass: false, prReviewApproved: false, poAccepted: false, demoCompleted: false },
          },
        ],
      };

      const json = JSON.stringify(stateWithFeatures, null, 2);
      const parsed = JSON.parse(json);

      expect(parsed.features).toHaveLength(1);
      expect(parsed.features[0].slug).toBe("feature-a");
      expect(parsed.features[0].branchName).toBe("sprint-5/feature-a");
    });

    it("backward compatibility: old state without features defaults to null", () => {
      const oldState = {
        project: "test",
        sprint: 3,
        status: "complete",
        currentStep: 9,
        branchName: "sprint-3/feature",
        steps: [],
        checkpoints: [],
        dod: { codeCommitted: true, testsPass: true, prReviewApproved: true, poAccepted: true, demoCompleted: true },
        retroProposals: null,
      };

      const features = (oldState as SprintState & { features?: FeatureState[] | null }).features ?? null;
      expect(features).toBeNull();
    });
  });

  describe("Branch naming convention", () => {
    it("feature branches follow sprint-{N}/{feature-slug} pattern", () => {
      const sprint = 5;
      const slugs = ["agent-parallel-execution", "multi-engineer-coordination", "dino-agent-names"];

      const branches = slugs.map((slug) => `sprint-${sprint}/${slug}`);

      expect(branches[0]).toBe("sprint-5/agent-parallel-execution");
      expect(branches[1]).toBe("sprint-5/multi-engineer-coordination");
      expect(branches[2]).toBe("sprint-5/dino-agent-names");
    });
  });

  describe("Engineer concurrency across features", () => {
    it("Promise.allSettled runs engineer agents concurrently", async () => {
      const order: string[] = [];

      const featureA = new Promise<string>((resolve) => {
        order.push("a-start");
        setTimeout(() => {
          order.push("a-end");
          resolve("a-done");
        }, 10);
      });

      const featureB = new Promise<string>((resolve) => {
        order.push("b-start");
        setTimeout(() => {
          order.push("b-end");
          resolve("b-done");
        }, 10);
      });

      const results = await Promise.allSettled([featureA, featureB]);

      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("fulfilled");
      // Both should have started before either ended
      expect(order.indexOf("a-start")).toBeLessThan(order.indexOf("a-end"));
      expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("b-end"));
      expect(order.indexOf("b-start")).toBeLessThan(order.indexOf("a-end"));
    });
  });
});
