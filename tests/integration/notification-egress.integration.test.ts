/**
 * Integration tests — notification-egress (Sprint 16)
 *
 * Spec:         docs/specs/notification-egress.md (AC 1–12)
 * Architecture: docs/architecture/notification-egress.md (v2 REDESIGN — local
 *               JSONL sink, ZERO network egress)
 *
 * SPEC/ARCHITECTURE DIVERGENCE (flagged to PO): the spec's Slack incoming-webhook
 * driver + `notifications.slack_webhook_url` secret + HTTP egress (AC 4/5/6/10) are
 * SUPERSEDED by the approved architecture v2: a durable local append-only JSONL
 * sink (`JsonlSinkDriver`) configured via `notifications.enabled`/`notifications.sinkPath`.
 * These tests target the AUTHORITATIVE architecture design; the unchanged spec ACs
 * (1, 2, 3, 7, 11, 12) are asserted verbatim in intent.
 *
 * PRODUCTION SEAM (TEAM.md QA rule 12 / AC 12): the notifier's single choke point
 * is `emitNotification`, invoked at the tool boundary after the runner returns and
 * the freshly-persisted `SprintState` is reloaded from disk. Its ONLY inputs are
 * persisted `SprintState` (+ git) — never agent stdout. The seam test below drives
 * the REAL `runSprintFromStep` to a parked checkpoint, reloads the persisted state
 * exactly as `tools.ts` will, and dispatches `emitNotification`. The only mock is
 * `spawnAgent` (sanctioned: so steps do not spawn real `claude`). The
 * driver-facing boundary is a FAKE `NotificationDriver`, per AC 12 ("driver
 * invoked with a payload derived from persisted state; HTTP/sink boundary faked").
 *
 * TDD note: this whole file is RED at step 3 — `emitNotification`,
 * `deriveNotificationEvent`, `buildResumeCommand`, `NotificationDriver`,
 * `JsonlSinkDriver`, `resolveDrivers`, the `notifications` config parse, and the
 * `SprintState.notifiedEvents` marker do not exist yet. That is the required state;
 * the Engineer turns them green in step 5. RED-verification notes are recorded on
 * every constraint-guarding test. Tests tagged [no-regression] are expected to pass
 * both before and after and are not constraint-guarding.
 */

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";

// Sanctioned mock (production-seam test): stop the runner from spawning real
// `claude` processes. Do NOT widen this mock — mocking the runner loop or the
// notifier itself would silently neuter the regression coverage this file exists
// for (the Sprint 10 false-green anti-pattern).
jest.mock("../../src/orchestrator/agents", () => {
  const actual = jest.requireActual("../../src/orchestrator/agents") as Record<string, unknown>;
  return {
    __esModule: true,
    ...actual,
    spawnAgent: jest.fn(),
  };
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import simpleGit from "simple-git";

import { loadConfig, RaptorConfig } from "../../src/config";

// NEW exports (RED until the Engineer implements the feature):
import {
  NotificationEvent,
  deriveNotificationEvent,
  buildResumeCommand,
  emitNotification,
} from "../../src/orchestrator/notifications";
import {
  NotificationDriver,
  JsonlSinkDriver,
  resolveDrivers,
} from "../../src/orchestrator/notification-driver";

import { runSprintFromStep } from "../../src/orchestrator/runner";
import { SPRINT_WORKFLOW, Role } from "../../src/orchestrator/workflow";
import {
  createInitialState,
  loadSprintState,
  saveSprintState,
  SprintState,
} from "../../src/orchestrator/state";
import { featureBranchName } from "../../src/orchestrator/multi-runner";
import { spawnAgent, AgentResult } from "../../src/orchestrator/agents";

const spawnAgentMock = spawnAgent as jest.MockedFunction<typeof spawnAgent>;

const SPRINT = 16;
const PROJECT = "myapp";
const SLUG = "notification-egress";
const OCCURRED_AT = "2026-07-12T18:04:00.000Z"; // fixed — no clock in tests

// ---------------------------------------------------------------------------
// Fake drivers (the faked delivery boundary — AC 12)
// ---------------------------------------------------------------------------

class CapturingDriver implements NotificationDriver {
  readonly name = "capture";
  readonly events: NotificationEvent[] = [];
  send(event: NotificationEvent): void {
    this.events.push(event);
  }
}

class ThrowingDriver implements NotificationDriver {
  readonly name = "throwing";
  calls = 0;
  send(): void {
    this.calls++;
    throw new Error("simulated sink failure");
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakeHome: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-notif-"));
  fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  // Sandbox ~/.raptor (state files) — matches the merge/adv-gate harnesses.
  jest.spyOn(os, "homedir").mockReturnValue(fakeHome);

  spawnAgentMock.mockReset();
  // Write the per-role required artifact (as a real agent would) so the REAL
  // runner's `expectedOutputs` gate is satisfied and the sprint ADVANCES to its
  // checkpoints. Without producing `docs/specs/{slug}.md`, step 1 (PO author
  // spec) can never satisfy its required output, burns its attempts, and the
  // sprint ESCALATES instead of parking at spec-review — which is exactly what
  // the AC-12 production-seam test asserts against.
  spawnAgentMock.mockImplementation(
    async (
      role: string,
      _systemPrompt: string,
      _context: string,
      _taskDescription: string,
      cwd: string
    ): Promise<AgentResult> => {
      const artifact: Record<string, string> = {
        po: path.join(cwd, "docs", "specs", `${SLUG}.md`),
        architect: path.join(cwd, "docs", "architecture", `${SLUG}.md`),
        qa: path.join(cwd, "tests", "bdd", `${SLUG}.feature`),
      };
      const target = artifact[role];
      if (target && !fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `# ${role} artifact for ${SLUG}\n`);
      }
      return { output: `${role} step done`, exitCode: 0 };
    }
  );
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(obj: unknown): string {
  const p = path.join(tmpDir, "config.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function workflowSteps() {
  return SPRINT_WORKFLOW.map((s) => ({ step: s.step, role: s.role, name: s.name }));
}

/** A single-feature SprintState with all fields explicit (mirrors createInitialState). */
function baseState(overrides: Partial<SprintState> = {}): SprintState {
  const state = createInitialState(
    PROJECT,
    SPRINT,
    workflowSteps(),
    featureBranchName(SPRINT, SLUG)
  );
  // notifiedEvents is the additive dedup marker (loadSprintState defaults it to []).
  (state as SprintState & { notifiedEvents: string[] }).notifiedEvents = [];
  return { ...state, ...overrides };
}

/** State parked at a checkpoint (status paused, a fresh pending checkpoint pushed). */
function checkpointState(): SprintState {
  const s = baseState({ status: "paused", currentStep: 6 });
  s.checkpoints = [
    { type: "pr-review", status: "pending", feedback: null, resolvedAt: null, feature: null },
  ];
  return s;
}

/** State escalated at a step (status escalated, escalationReason recorded). */
function escalatedState(): SprintState {
  const s = baseState({ status: "escalated", currentStep: 7 });
  const step7 = s.steps.find((st) => st.step === 7)!;
  step7.status = "escalated";
  step7.escalationReason = "attempts-exhausted";
  return s;
}

/** Create a real git repo with a Raptor-format single-feature backlog. */
async function initProject(name: string): Promise<string> {
  const projectPath = path.join(tmpDir, name);
  fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, "docs", "backlog.md"),
    `# Backlog\n\n## Sprint ${SPRINT}\n- [ ] ${SLUG}: out-of-band sprint notifications\n\n## Ready\n\n## Inbox\n\n## Done\n`
  );
  const git = simpleGit(projectPath);
  await git.init();
  await git.addConfig("user.name", "Vex Velociraptor");
  await git.addConfig("user.email", "vex@raptor.test");
  await git.add(".");
  await git.commit("[PO] add: sprint backlog");
  return projectPath;
}

// ===========================================================================
// AC 1 — Four events fire, and ONLY these four (via the emitNotification seam)
// ===========================================================================

describe("AC 1: exactly one send per lifecycle event, none for in-progress", () => {
  // RED-verification: fails to resolve until `emitNotification` /
  // `NotificationDriver` exist; on pre-change `main` there is no emission path at
  // all, so no driver is ever invoked.
  const cases: Array<[string, () => SprintState, NotificationEvent["event"]]> = [
    ["checkpoint", checkpointState, "checkpoint"],
    ["escalation", escalatedState, "escalation"],
    ["complete", () => baseState({ status: "complete" }), "complete"],
    ["failed", () => baseState({ status: "failed" }), "failed"],
  ];

  for (const [label, make, expected] of cases) {
    it(`${label} state → exactly one "${expected}" send`, async () => {
      const driver = new CapturingDriver();
      await emitNotification(make(), [driver], {
        projectSlug: SLUG,
        occurredAt: OCCURRED_AT,
        save: () => {},
      });
      expect(driver.events).toHaveLength(1);
      expect(driver.events[0].event).toBe(expected);
      expect(driver.events[0].status).toBe(make().status);
    });
  }

  it("in-progress state → no send (ordinary progress is not notifiable) (AC 1)", async () => {
    // RED-verification: guards against an implementation that notifies on every
    // invocation; a naive emitter would send here.
    const driver = new CapturingDriver();
    await emitNotification(baseState({ status: "in-progress" }), [driver], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save: () => {},
    });
    expect(driver.events).toHaveLength(0);
  });
});

// ===========================================================================
// AC 2 / NFR-6 — Payload derived from persisted state, never agent self-report
// ===========================================================================

describe("AC 2: payload derives from persisted state, not agent self-report", () => {
  it("an escalated state never yields a 'complete' notification even if an agent claims success", async () => {
    // RED-verification: the counterfeit this rule prevents. Proven RED by feeding
    // a state whose status is `escalated` while attaching a divergent agent
    // report; a self-report-driven emitter would emit "complete". The derived
    // event MUST follow persisted status.
    const state = escalatedState();
    // Simulate an agent that lies about success — the notifier must ignore it.
    (state as SprintState & { agentReport?: string }).agentReport =
      "All done! Sprint complete, everything green.";

    const driver = new CapturingDriver();
    await emitNotification(state, [driver], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save: () => {},
    });

    expect(driver.events).toHaveLength(1);
    expect(driver.events[0].event).toBe("escalation");
    expect(driver.events[0].status).toBe("escalated");
    expect(driver.events.some((e) => e.event === "complete")).toBe(false);
  });

  it("project and sprint on the event come from persisted state (AC 2)", () => {
    // RED-verification: `deriveNotificationEvent` does not exist pre-change.
    const event = deriveNotificationEvent(baseState({ status: "complete" }), {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
    });
    expect(event).not.toBeNull();
    expect(event!.project).toBe(PROJECT);
    expect(event!.sprint).toBe(SPRINT);
  });

  it("deriveNotificationEvent returns null for a non-notifiable (in-progress) status", () => {
    const event = deriveNotificationEvent(baseState({ status: "in-progress" }), {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
    });
    expect(event).toBeNull();
  });
});

// ===========================================================================
// AC 3 — Actionable payload includes the exact resume_sprint command
// ===========================================================================

describe("AC 3: actionable events carry the exact resume_sprint command", () => {
  it("a checkpoint event's resumeCommand names project, sprint, and an action", async () => {
    // RED-verification: `buildResumeCommand` does not exist pre-change; no event
    // carries a resume command.
    const driver = new CapturingDriver();
    await emitNotification(checkpointState(), [driver], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save: () => {},
    });
    const cmd = driver.events[0].resumeCommand ?? "";
    expect(cmd).toContain("resume_sprint");
    expect(cmd).toContain(`sprint=${SPRINT}`);
    expect(cmd).toMatch(new RegExp(`name="?${PROJECT}"?`));
    expect(cmd).toMatch(/action="?(approve|request-changes)"?/);
  });

  it("buildResumeCommand maps 1:1 to resumeSprintTool args {name, sprint, action, feature?} (OQ4)", () => {
    const state = checkpointState();
    const event = deriveNotificationEvent(state, {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
    })!;
    const cmd = buildResumeCommand(state, event);
    expect(cmd).not.toBeNull();
    // The command names the tool and every required argument the user must supply.
    expect(cmd).toContain("resume_sprint");
    expect(cmd).toContain(`name="${PROJECT}"`);
    expect(cmd).toContain(`sprint=${SPRINT}`);
    expect(cmd).toContain("action=");
  });

  it("a multi-feature escalation targets the escalated feature slug in its command (AC 3, edge case)", async () => {
    // RED-verification: the mixed-terminal edge case. Proven RED by asserting the
    // escalated feature slug appears in the reconstructed command — impossible
    // without buildResumeCommand.
    const s = baseState({ status: "escalated", currentStep: 7 });
    s.currentFeatureSlug = SLUG;
    s.features = [
      {
        slug: "other-feature",
        branchName: `sprint-${SPRINT}/other-feature`,
        status: "complete",
        currentStep: 9,
        steps: [],
        dod: {
          codeCommitted: true,
          testsPass: true,
          prReviewApproved: true,
          poAccepted: true,
          demoCompleted: true,
        },
      },
      {
        slug: SLUG,
        branchName: featureBranchName(SPRINT, SLUG),
        status: "escalated",
        currentStep: 7,
        steps: [],
        dod: {
          codeCommitted: false,
          testsPass: false,
          prReviewApproved: false,
          poAccepted: false,
          demoCompleted: false,
        },
      },
    ];

    const driver = new CapturingDriver();
    await emitNotification(s, [driver], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save: () => {},
    });
    expect(driver.events).toHaveLength(1);
    expect(driver.events[0].event).toBe("escalation");
    expect(driver.events[0].resumeCommand ?? "").toContain(SLUG);
  });

  it("terminal (complete) events carry a null resume command (AC 3)", async () => {
    const driver = new CapturingDriver();
    await emitNotification(baseState({ status: "complete" }), [driver], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save: () => {},
    });
    expect(driver.events[0].resumeCommand).toBeNull();
  });
});

// ===========================================================================
// AC 4 — Pluggable channel abstraction (Slack driver superseded by sink)
// ===========================================================================

describe("AC 4: pluggable NotificationDriver abstraction (jsonl-sink ships)", () => {
  it("resolveDrivers returns a single jsonl-sink driver when enabled (AC 4)", () => {
    // RED-verification: `resolveDrivers`/`JsonlSinkDriver` do not exist pre-change.
    const cfg: RaptorConfig = { projectsBaseDir: "/tmp/x", teamTemplatePath: null };
    const sink = path.join(tmpDir, "notifications.jsonl");
    const drivers = resolveDrivers(cfg, sink);
    expect(drivers).toHaveLength(1);
    expect(drivers[0].name).toBe("jsonl-sink");
    expect(drivers[0]).toBeInstanceOf(JsonlSinkDriver);
  });

  it("a second driver implementing the interface receives the same event — no call-site change (AC 4)", async () => {
    // RED-verification: proves the emission choke point depends on the interface,
    // not a concrete channel — a future Discord driver slots in with no call-site
    // edit. Fails pre-change (no emission path).
    const a = new CapturingDriver();
    const b = new CapturingDriver();
    await emitNotification(baseState({ status: "complete" }), [a, b], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save: () => {},
    });
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(a.events[0].event).toBe(b.events[0].event);
  });
});

// ===========================================================================
// AC 6 / AC 7 — config parsed in loadConfig; parsed-vs-declared conformance
// ===========================================================================

describe("AC 6/7: loadConfig parses the notifications key (no dead plumbing)", () => {
  it("parses notifications.enabled and notifications.sinkPath from a config file (AC 7)", () => {
    // RED-verification (AC 7): fails against a loadConfig that DECLARES but does
    // NOT parse `notifications` (the config-keys-parsed-vs-declared defect class).
    // On such a build, `config.notifications` is undefined and these expects fail.
    const cfgPath = writeConfig({
      notifications: { enabled: true, sinkPath: "/custom/notifications.jsonl" },
    });
    const config = loadConfig(cfgPath);
    expect(config.notifications).toBeDefined();
    expect(config.notifications?.enabled).toBe(true);
    expect(config.notifications?.sinkPath).toBe("/custom/notifications.jsonl");
  });

  it("drops malformed notifications field-wise and never throws (AC 6, edge case)", () => {
    // notifications as a string / array → ignored entirely.
    const stringPath = writeConfig({ notifications: "nope" });
    expect(() => loadConfig(stringPath)).not.toThrow();
    expect(loadConfig(stringPath).notifications).toBeUndefined();

    const arrayPath = writeConfig({ notifications: ["a", "b"] });
    expect(() => loadConfig(arrayPath)).not.toThrow();
    expect(loadConfig(arrayPath).notifications).toBeUndefined();

    // Wrong field types dropped field-wise (mirrors parseModels/parseTimeouts).
    const junkPath = writeConfig({
      notifications: { enabled: "yes", sinkPath: 5, junk: 1 },
    });
    let parsed!: RaptorConfig;
    expect(() => (parsed = loadConfig(junkPath))).not.toThrow();
    expect(parsed.notifications?.enabled).toBeUndefined();
    expect(parsed.notifications?.sinkPath).toBeUndefined();
    expect(
      (parsed.notifications as Record<string, unknown> | undefined)?.junk
    ).toBeUndefined();

    // An empty-string sinkPath is not a usable path → dropped.
    const emptyPath = writeConfig({ notifications: { sinkPath: "" } });
    expect(loadConfig(emptyPath).notifications?.sinkPath).toBeUndefined();
  });

  it("[no-regression] a config with no notifications key leaves config.notifications undefined", () => {
    const cfgPath = writeConfig({ projectsBaseDir: "/tmp/x" });
    expect(loadConfig(cfgPath).notifications).toBeUndefined();
  });
});

// ===========================================================================
// AC 8 / NFR-2 — default-off parity via the hard off-switch
// ===========================================================================

describe("AC 8/NFR-2: hard off-switch → byte-for-byte pre-feature parity", () => {
  it("resolveDrivers returns [] when notifications.enabled === false (AC 8)", () => {
    // RED-verification: the off-switch. A build that always returns a driver
    // fails here.
    const cfg: RaptorConfig = {
      projectsBaseDir: "/tmp/x",
      teamTemplatePath: null,
      notifications: { enabled: false },
    };
    expect(resolveDrivers(cfg, path.join(tmpDir, "n.jsonl"))).toEqual([]);
  });

  it("emitNotification with zero drivers writes no sink file and no notified-events marker (AC 8)", async () => {
    // RED-verification: the parity guarantee. With drivers=[] there must be no I/O
    // and no state mutation — observable behavior identical to pre-feature.
    const state = baseState({ status: "complete" });
    const before = JSON.stringify(state.notifiedEvents ?? []);
    let saved = false;
    await emitNotification(state, [], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save: () => {
        saved = true;
      },
    });
    expect(saved).toBe(false);
    expect(JSON.stringify(state.notifiedEvents ?? [])).toBe(before);
    // No sink file created anywhere under the sandboxed home.
    const sink = path.join(fakeHome, ".raptor", SLUG, "notifications.jsonl");
    expect(fs.existsSync(sink)).toBe(false);
  });
});

// ===========================================================================
// AC 9 / NFR-1 — notification failure never breaks the sprint
// ===========================================================================

describe("AC 9/NFR-1: best-effort — a failing driver never disturbs the sprint", () => {
  it("a throwing driver does not cause emitNotification to reject", async () => {
    // RED-verification: proven RED by a driver that throws on send; a naive
    // emitter that awaits driver.send without isolation would reject.
    const bad = new ThrowingDriver();
    await expect(
      emitNotification(baseState({ status: "complete" }), [bad], {
        projectSlug: SLUG,
        occurredAt: OCCURRED_AT,
        save: () => {},
      })
    ).resolves.toBeUndefined();
    expect(bad.calls).toBe(1);
  });

  it("a throwing driver leaves sprint state (status, steps) unchanged (AC 9)", async () => {
    const state = escalatedState();
    const snapshot = JSON.stringify({ status: state.status, steps: state.steps });
    await emitNotification(state, [new ThrowingDriver()], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save: () => {},
    });
    expect(JSON.stringify({ status: state.status, steps: state.steps })).toBe(snapshot);
  });

  it("a good driver still sends when a sibling driver throws (per-driver isolation)", async () => {
    const good = new CapturingDriver();
    const bad = new ThrowingDriver();
    await emitNotification(baseState({ status: "failed" }), [bad, good], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save: () => {},
    });
    expect(good.events).toHaveLength(1);
    expect(good.events[0].event).toBe("failed");
  });
});

// ===========================================================================
// AC 11 / NFR-4 — at most one notification per event (dedup on re-entry)
// ===========================================================================

describe("AC 11/NFR-4: at-most-once per lifecycle event", () => {
  it("re-entering an already-notified checkpoint sends no duplicate", async () => {
    // RED-verification: proven RED by dispatching twice against the SAME state
    // object (whose notifiedEvents marker is populated by the first successful
    // send); without the marker/dedup the second call sends again.
    const state = checkpointState();
    const driver = new CapturingDriver();
    const save = (s: SprintState) => saveSprintState(SLUG, SPRINT, s);

    await emitNotification(state, [driver], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save,
    });
    await emitNotification(state, [driver], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save,
    });

    expect(driver.events).toHaveLength(1);
  });

  it("re-reading a terminal state sends no duplicate complete event", async () => {
    const state = baseState({ status: "complete" });
    const driver = new CapturingDriver();
    for (let i = 0; i < 3; i++) {
      await emitNotification(state, [driver], {
        projectSlug: SLUG,
        occurredAt: OCCURRED_AT,
        save: () => {},
      });
    }
    expect(driver.events).toHaveLength(1);
  });

  it("a distinct, genuinely-new checkpoint DOES notify after the first (AC 11)", async () => {
    // RED-verification: guards against over-dedup that would swallow real new
    // events. A second, distinct checkpoint (new checkpoints[] entry) must notify.
    const state = checkpointState();
    const driver = new CapturingDriver();
    await emitNotification(state, [driver], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save: () => {},
    });

    // First checkpoint approved; sprint parks at a second, distinct checkpoint.
    state.checkpoints[0].status = "approved";
    state.checkpoints.push({
      type: "demo-feedback",
      status: "pending",
      feedback: null,
      resolvedAt: null,
      feature: null,
    });
    state.currentStep = 8;

    await emitNotification(state, [driver], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save: () => {},
    });

    expect(driver.events).toHaveLength(2);
    expect(driver.events[1].event).toBe("checkpoint");
  });
});

// ===========================================================================
// AC 10 / NFR-5 — no secret, no agent stdout in the serialized event
// ===========================================================================

describe("AC 10/NFR-5: emitted event carries only state-derived data", () => {
  it("the serialized event line contains no agent report text and no url/credential", async () => {
    const state = escalatedState();
    (state as SprintState & { agentReport?: string }).agentReport =
      "secret-token=abc123 https://hooks.slack.com/services/XXX all green";

    const driver = new CapturingDriver();
    await emitNotification(state, [driver], {
      projectSlug: SLUG,
      occurredAt: OCCURRED_AT,
      save: () => {},
    });
    const line = JSON.stringify(driver.events[0]);
    expect(line).not.toContain("secret-token");
    expect(line).not.toContain("hooks.slack.com");
    expect(line).not.toContain("all green");
    // Only the declared, state-derived envelope keys are present.
    expect(new Set(Object.keys(driver.events[0]))).toEqual(
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
  });
});

// ===========================================================================
// NFR-9 — JsonlSinkDriver durability / append integrity
// ===========================================================================

describe("NFR-9: JsonlSinkDriver appends one JSON line per event, preserving prior lines", () => {
  function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
    return {
      event: "complete",
      project: PROJECT,
      sprint: SPRINT,
      status: "complete",
      feature: SLUG,
      reason: null,
      resumeCommand: null,
      eventKey: `complete:${SPRINT}:sprint:-`,
      occurredAt: OCCURRED_AT,
      ...overrides,
    };
  }

  it("creates the sink and its parent directory, writing one line per send", () => {
    // RED-verification: JsonlSinkDriver does not exist pre-change.
    const sink = path.join(tmpDir, "nested", "notifications.jsonl");
    const driver = new JsonlSinkDriver(sink);

    driver.send(event({ eventKey: "a" }));
    driver.send(event({ eventKey: "b", event: "failed", status: "failed" }));

    const lines = fs.readFileSync(sink, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    // Both lines are well-formed JSON and the first is intact.
    const first = JSON.parse(lines[0]) as NotificationEvent;
    const second = JSON.parse(lines[1]) as NotificationEvent;
    expect(first.eventKey).toBe("a");
    expect(second.eventKey).toBe("b");
    expect(second.event).toBe("failed");
  });
});

// ===========================================================================
// AC 12 — PRODUCTION SEAM: real runner → persisted state → tool-boundary emit
// ===========================================================================

describe("AC 12: production seam — real sprint parks, boundary reloads persisted state, driver invoked", () => {
  it("running from step 1 parks at spec-review; the reloaded persisted state yields one checkpoint event", async () => {
    // RED-verification: this drives the REAL runSprintFromStep to a parked
    // checkpoint (status paused) and then dispatches emitNotification against the
    // RELOADED persisted state — exactly what tools.ts will do at the boundary.
    // Pre-change there is no notifier, so the reload+emit path cannot exist. The
    // payload is derived from persisted state (loadSprintState), never agent
    // stdout — structurally guaranteeing AC 2 at the seam.
    const projectPath = await initProject(PROJECT);

    const runResult = await runSprintFromStep(projectPath, PROJECT, SPRINT, 1);
    expect(runResult.status).toBe("checkpoint");

    // Boundary reload — the notifier's ONLY input is persisted state.
    const persisted = loadSprintState(PROJECT, SPRINT);
    expect(persisted).not.toBeNull();
    expect(persisted!.status).toBe("paused");

    const driver = new CapturingDriver();
    await emitNotification(persisted!, [driver], {
      projectSlug: PROJECT,
      occurredAt: OCCURRED_AT,
      save: (s) => saveSprintState(PROJECT, SPRINT, s),
    });

    expect(driver.events).toHaveLength(1);
    const ev = driver.events[0];
    expect(ev.event).toBe("checkpoint");
    expect(ev.project).toBe(PROJECT);
    expect(ev.sprint).toBe(SPRINT);
    expect(ev.status).toBe("paused");
    // Actionable: the copy-paste resume command is present (AC 3).
    expect(ev.resumeCommand ?? "").toContain("resume_sprint");
  });

  it("re-dispatching after a boundary reload of the same parked state sends no duplicate (AC 11 at the seam)", async () => {
    const projectPath = await initProject(PROJECT);
    await runSprintFromStep(projectPath, PROJECT, SPRINT, 1);

    const driver = new CapturingDriver();
    const save = (s: SprintState) => saveSprintState(PROJECT, SPRINT, s);

    // First boundary dispatch persists the notified marker.
    await emitNotification(loadSprintState(PROJECT, SPRINT)!, [driver], {
      projectSlug: PROJECT,
      occurredAt: OCCURRED_AT,
      save,
    });
    // Second boundary dispatch reloads the SAME (still-parked) persisted state.
    await emitNotification(loadSprintState(PROJECT, SPRINT)!, [driver], {
      projectSlug: PROJECT,
      occurredAt: OCCURRED_AT,
      save,
    });

    expect(driver.events).toHaveLength(1);
  });
});
