/**
 * Integration tests — surface-tool-errors-to-openstory (Sprint 16)
 *
 * Spec:         docs/specs/surface-tool-errors-to-openstory.md (AC 1–10)
 * Architecture: docs/architecture/surface-tool-errors-to-openstory.md (D1–D4)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PRODUCTION SEAM (AC #10 / TEAM.md QA rule 12)
 * ─────────────────────────────────────────────────────────────────────────
 * The surfacing seam lives at the src/index.ts registration layer, which wraps
 * each tool handler as:
 *
 *     async (args) => {
 *       try {
 *         const result = await <toolFn>(ctx, args);
 *         const content = buildContent(result);        // existing per-tool content
 *         return surfaceOutcome(result, content);       // adds isError iff status ∈ FAILURE_STATUSES
 *       } catch (err) {
 *         return buildThrownErrorResult("<tool_name>", err);
 *       }
 *     }
 *
 * index.ts's main() only wires stdio and cannot be invoked without a live
 * transport. Per the architecture ("Tests drive the actual index.ts
 * registration/wrapping path OR the exported surfaceOutcome /
 * buildThrownErrorResult invoked EXACTLY as the seam invokes them"), these
 * tests drive the REAL tool functions from src/tools.ts and route their real
 * returns through the REAL `surfaceOutcome` / `buildThrownErrorResult` from
 * src/error-surfacing.ts, wrapped by the `runThroughSeam` helper below — a
 * faithful transcription of the index.ts handler, NOT a hand-rolled fake of the
 * surfacing policy. The classification decision (`surfaceOutcome`) is the real
 * production code under test; only the stdio transport is elided.
 *
 * NO tool implementation is mocked. The tools run against REAL tmp dirs, a REAL
 * Registry JSON, and a REAL git repo (for the thrown-exception path), exactly as
 * they do in production.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RED-VERIFICATION NOTES (TEAM.md QA rule 12 — proven to FAIL pre-change)
 * ─────────────────────────────────────────────────────────────────────────
 * Current `main` (2026-07-12): src/index.ts wraps every returned object as
 * `{ content: [{ type:"text", text: JSON.stringify(result, null, 2) }] }` and
 * NEVER sets isError (lines 81/114/127/144/186/237). `src/error-surfacing.ts`
 * does not exist. Therefore:
 *   [IMPORT-RED] this file fails to compile/import against pre-change code —
 *     surfaceOutcome / buildThrownErrorResult / isFailureStatus / FAILURE_STATUSES
 *     are not exported yet.
 *   [FAIL-RED]  each "detectable failure" test asserts isError === true; the
 *     pre-change swallow-into-success wrapping yields a result with NO isError,
 *     so those asserts go RED. How verified: implement surfaceOutcome as a stub
 *     that always returns `{ content }` (today's behavior) — every failure test
 *     below turns RED while the success-parity test stays GREEN.
 *   [PARITY-RED] the success-parity test asserts NO isError key on success; it
 *     goes RED if surfaceOutcome ever attaches isError (even `false`) to a
 *     success result (AC #5, TEAM.md QA rule 13 default/success parity).
 *
 * There is optional-config-free surfacing here (it is unconditional at the
 * boundary), so the TEAM.md QA rule 13 "default-off parity" analog is the
 * success-parity test: proving a *successful* call's CallToolResult is
 * byte-for-byte identical to today's wrapping.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import simpleGit from "simple-git";

import {
  bootstrapProject,
  adoptProject,
  listProjects,
  getProjectStatus,
  runSprint,
  resumeSprintTool,
  ToolContext,
} from "../../src/tools";
import { Registry } from "../../src/registry";

// The system under test — the real surfacing seam (does not exist until the
// Engineer implements src/error-surfacing.ts; this import is the [IMPORT-RED]).
import {
  surfaceOutcome,
  buildThrownErrorResult,
  isFailureStatus,
  FAILURE_STATUSES,
} from "../../src/error-surfacing";

// ---------------------------------------------------------------------------
// Types & seam transcription (faithful to src/index.ts)
// ---------------------------------------------------------------------------

type TextContent = { type: "text"; text: string };
type SurfacedResult = { content: TextContent[]; isError?: true };

/** The four JSON-stringify tools' content builder — verbatim from index.ts. */
function buildJsonContent(result: Record<string, unknown>): TextContent[] {
  return [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
}

/** run_sprint / resume_sprint content builder — verbatim from index.ts. */
function buildSprintContent(result: Record<string, unknown>): TextContent[] {
  const content: TextContent[] = [];
  if (result.progress) {
    content.push({ type: "text" as const, text: result.progress as string });
  }
  if (result.checkpoint) {
    const cp = result.checkpoint as { title: string; context: string };
    content.push({
      type: "text" as const,
      text: `\n## Checkpoint: ${cp.title}\n\n${cp.context}`,
    });
  }
  if (result.message) {
    content.push({ type: "text" as const, text: result.message as string });
  }
  return content;
}

/**
 * Faithful transcription of the index.ts registered-handler wrapper. Routes a
 * REAL tool invocation through the REAL surfacing seam. `buildContent` mirrors
 * the exact per-tool content assembly index.ts uses.
 */
async function runThroughSeam(
  toolName: string,
  run: () => Promise<Record<string, unknown>>,
  buildContent: (r: Record<string, unknown>) => TextContent[]
): Promise<SurfacedResult> {
  try {
    const result = await run();
    const content = buildContent(result);
    return surfaceOutcome(result, content) as SurfacedResult;
  } catch (err) {
    return buildThrownErrorResult(toolName, err) as SurfacedResult;
  }
}

// ---------------------------------------------------------------------------
// Harness — real tmp home, registry, template
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakeHome: string;
let ctx: ToolContext;

const TEMPLATE_PATH = path.resolve(__dirname, "../../template/TEAM.md");

function makeCtx(): ToolContext {
  const registry = new Registry(path.join(fakeHome, ".raptor", "projects.json"));
  return {
    projectsBaseDir: path.join(tmpDir, "workspace"),
    registry,
    templatePath: TEMPLATE_PATH,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-surface-errors-"));
  fakeHome = path.join(tmpDir, "home");
  fs.mkdirSync(fakeHome, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "workspace"), { recursive: true });
  ctx = makeCtx();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Register a real project dir (git repo) with a backlog that has NO sprint items. */
async function makeRegisteredProject(
  name: string,
  opts: { backlog?: string | null } = {}
): Promise<string> {
  const projectPath = path.join(tmpDir, "workspace", name);
  fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
  const git = simpleGit(projectPath);
  await git.init();
  await git.addConfig("user.name", "Vex Velociraptor");
  await git.addConfig("user.email", "vex@raptor.test");
  if (opts.backlog !== null) {
    fs.writeFileSync(
      path.join(projectPath, "docs", "backlog.md"),
      opts.backlog ?? "# Backlog\n\n## Sprint 1\n\n## Ready\n\n## Inbox\n\n## Done\n"
    );
  }
  await git.add("-A").catch(() => undefined);
  await git.commit("[PO] add: backlog").catch(() => undefined);
  await ctx.registry.addProject({
    name,
    slug: name,
    description: "test project",
    path: projectPath,
    createdAt: new Date().toISOString(),
  });
  return projectPath;
}

// ===========================================================================
// AC #1, #2, #6, #10a — each family of failure return surfaces as a boundary failure
// ===========================================================================

describe("failure returns surface as detectable boundary failures (AC #1, #2, #6, #10a)", () => {
  it("[FAIL-RED] invalid project name → isError true, structured body preserved", async () => {
    const surfaced = await runThroughSeam(
      "bootstrap_project",
      () => bootstrapProject(ctx, { name: "Bad_Name", description: "x" }),
      buildJsonContent
    );

    // AC #1/#2: the boundary signal is the structured isError flag.
    expect(surfaced.isError).toBe(true);
    // AC #5/#2: the { status, message } JSON body is preserved unchanged in content.
    const body = JSON.parse(surfaced.content[0].text);
    expect(body.status).toBe("error");
    expect(typeof body.message).toBe("string");
    // Classification does NOT depend on the word "error" appearing in prose.
    expect(isFailureStatus(body.status)).toBe(true);
  });

  it("[FAIL-RED] duplicate project → isError true", async () => {
    await bootstrapProject(ctx, { name: "dup-app", description: "first" });
    const surfaced = await runThroughSeam(
      "bootstrap_project",
      () => bootstrapProject(ctx, { name: "dup-app", description: "second" }),
      buildJsonContent
    );
    expect(surfaced.isError).toBe(true);
    expect(JSON.parse(surfaced.content[0].text).status).toBe("error");
  });

  it("[FAIL-RED] adopt_project on a non-existent path → isError true", async () => {
    const surfaced = await runThroughSeam(
      "adopt_project",
      () =>
        adoptProject(ctx, {
          path: path.join(tmpDir, "nope-does-not-exist"),
          name: "ghost",
          description: "x",
        }),
      buildJsonContent
    );
    expect(surfaced.isError).toBe(true);
    expect(JSON.parse(surfaced.content[0].text).status).toBe("error");
  });

  it("[FAIL-RED] get_project_status for an unknown project → isError true", async () => {
    const surfaced = await runThroughSeam(
      "get_project_status",
      () => getProjectStatus(ctx, { name: "unknown-proj" }),
      buildJsonContent
    );
    expect(surfaced.isError).toBe(true);
    expect(JSON.parse(surfaced.content[0].text).status).toBe("error");
  });

  it("[FAIL-RED] run_sprint for an unknown project → isError true", async () => {
    const surfaced = await runThroughSeam(
      "run_sprint",
      () => runSprint(ctx, { name: "unknown-proj", sprint: 1 }),
      buildSprintContent
    );
    expect(surfaced.isError).toBe(true);
    // The run_sprint content builder surfaces the message text, and the seam
    // classifies from result.status === "error" (not from prose).
    expect(surfaced.content.some((c) => /not found/i.test(c.text))).toBe(true);
  });

  it("[FAIL-RED] run_sprint with no backlog items for the sprint → isError true", async () => {
    // Backlog exists but the Sprint 1 section is empty → tools.ts returns {status:"error"}.
    await makeRegisteredProject("empty-sprint", {
      backlog: "# Backlog\n\n## Sprint 1\n\n## Ready\n\n## Inbox\n\n## Done\n",
    });
    const surfaced = await runThroughSeam(
      "run_sprint",
      () => runSprint(ctx, { name: "empty-sprint", sprint: 1 }),
      buildSprintContent
    );
    expect(surfaced.isError).toBe(true);
  });

  it("[FAIL-RED] run_sprint with no backlog.md present → isError true", async () => {
    await makeRegisteredProject("no-backlog", { backlog: null });
    const surfaced = await runThroughSeam(
      "run_sprint",
      () => runSprint(ctx, { name: "no-backlog", sprint: 1 }),
      buildSprintContent
    );
    expect(surfaced.isError).toBe(true);
  });

  it("[FAIL-RED] resume_sprint for an unknown project → isError true", async () => {
    const surfaced = await runThroughSeam(
      "resume_sprint",
      () =>
        resumeSprintTool(ctx, {
          name: "unknown-proj",
          sprint: 1,
          action: "approve",
        }),
      buildSprintContent
    );
    expect(surfaced.isError).toBe(true);
  });
});

// ===========================================================================
// AC #4 — thrown exceptions surface consistently with {status:"error"} returns
// ===========================================================================

describe("thrown exceptions surface consistently (AC #4)", () => {
  it("[FAIL-RED] a thrown exception inside a handler → isError true + structured {status,tool,message}", async () => {
    const boom = new Error("simulated fs/simple-git failure");
    const surfaced = await runThroughSeam(
      "bootstrap_project",
      async () => {
        throw boom;
      },
      buildJsonContent
    );

    expect(surfaced.isError).toBe(true);
    const body = JSON.parse(surfaced.content[0].text);
    // Structured, classifiable body (AC #2/#4).
    expect(body.status).toBe("error");
    expect(body.tool).toBe("bootstrap_project");
    expect(body.message).toContain("simulated fs/simple-git failure");
  });

  it("a thrown failure and a {status:\"error\"} return are indistinguishable to a boundary detector", async () => {
    const thrown = await runThroughSeam(
      "get_project_status",
      async () => {
        throw new Error("kaboom");
      },
      buildJsonContent
    );
    const returned = await runThroughSeam(
      "get_project_status",
      () => getProjectStatus(ctx, { name: "unknown-proj" }),
      buildJsonContent
    );
    // Both carry the identical boundary signal (AC #4 consistency).
    expect(thrown.isError).toBe(true);
    expect(returned.isError).toBe(true);
    expect(thrown.isError).toBe(returned.isError);
  });
});

// ===========================================================================
// AC #5, #10c — success parity: byte-for-byte unchanged, NO isError key
// ===========================================================================

describe("success paths are byte-for-byte unchanged (AC #5, #10c)", () => {
  it("[PARITY-RED] a successful list_projects call carries NO isError key", async () => {
    await bootstrapProject(ctx, { name: "alpha", description: "a" });
    const result = await listProjects(ctx);
    const surfaced = await runThroughSeam(
      "list_projects",
      () => Promise.resolve(result),
      buildJsonContent
    );

    // AC #5: isError is OMITTED entirely (not set to false).
    expect("isError" in surfaced).toBe(false);
    // Byte-for-byte identical to today's JSON.stringify wrapping.
    expect(surfaced.content).toEqual([
      { type: "text", text: JSON.stringify(result, null, 2) },
    ]);
  });

  it("[PARITY-RED] a successful bootstrap_project result is unchanged and unflagged", async () => {
    const surfaced = await runThroughSeam(
      "bootstrap_project",
      () => bootstrapProject(ctx, { name: "beta", description: "b" }),
      buildJsonContent
    );
    const body = JSON.parse(surfaced.content[0].text);
    expect(body.status).toBe("success");
    expect("isError" in surfaced).toBe(false);
  });

  it("a success message that merely mentions 'error' is NOT misclassified", async () => {
    // Structured status is success; the word "error" in prose must not trigger a flag.
    const fake = { status: "success", message: "completed with no error" };
    const surfaced = surfaceOutcome(fake, buildJsonContent(fake)) as SurfacedResult;
    expect("isError" in surfaced).toBe(false);
  });
});

// ===========================================================================
// AC #8, #10d — run_sprint / resume_sprint lifecycle outcome fidelity
// ===========================================================================

describe("lifecycle outcome fidelity — no over-triggering (AC #8, #10d)", () => {
  it("[FAIL-RED] a terminal orchestrator 'failed' surfaces as isError true", () => {
    const result = { status: "failed", message: "sprint failed", progress: "table" };
    const surfaced = surfaceOutcome(result, buildSprintContent(result)) as SurfacedResult;
    expect(surfaced.isError).toBe(true);
  });

  it.each(["complete", "paused", "in-progress"])(
    "[PARITY-RED] a healthy '%s' lifecycle status is NOT surfaced as a failure",
    (status) => {
      const result = { status, message: `sprint ${status}`, progress: "table" };
      const surfaced = surfaceOutcome(result, buildSprintContent(result)) as SurfacedResult;
      expect("isError" in surfaced).toBe(false);
    }
  );

  it("'escalated' is attention-needed, NOT a boundary failure by default (Decision D4)", () => {
    const result = { status: "escalated", message: "handed off to user", progress: "table" };
    const surfaced = surfaceOutcome(result, buildSprintContent(result)) as SurfacedResult;
    // D4 recorded decision (PO sign-off): default is not-a-failure. Flipping this
    // is the one-line change of adding "escalated" to FAILURE_STATUSES.
    expect("isError" in surfaced).toBe(false);
  });
});

// ===========================================================================
// AC #3, #10b — conformance: no enumerated {status:"error"} return escapes surfacing
// ===========================================================================

describe("conformance guard — closed failure set covers every error return (AC #3, #10b)", () => {
  it("FAILURE_STATUSES is exactly {'error','failed'} and excludes healthy statuses (D3)", () => {
    expect(FAILURE_STATUSES.has("error")).toBe(true);
    expect(FAILURE_STATUSES.has("failed")).toBe(true);
    // Closed, precise set — unknown/new statuses default to not-a-failure.
    for (const healthy of ["success", "complete", "paused", "in-progress", "escalated"]) {
      expect(FAILURE_STATUSES.has(healthy)).toBe(false);
    }
    expect(FAILURE_STATUSES.size).toBe(2);
  });

  it("every 'status: \"error\"' return literal in src/tools.ts is a member of FAILURE_STATUSES", () => {
    // Parsed-vs-declared conformance (analogous to config-keys-parsed-vs-declared):
    // walk the real tools.ts source and prove no enumerated failure literal escapes
    // the surfacing set. A newly-added swallowed failure (unknown status) fails here.
    const toolsSrc = fs.readFileSync(
      path.resolve(__dirname, "../../src/tools.ts"),
      "utf-8"
    );
    const statusLiterals = [...toolsSrc.matchAll(/status:\s*"([^"]+)"/g)].map((m) => m[1]);
    const errorReturns = statusLiterals.filter((s) => s === "error");

    // Sanity: the spec enumerates ~19 {status:"error"} return sites.
    expect(errorReturns.length).toBeGreaterThanOrEqual(15);
    // Conformance: every failure literal that tools.ts actually returns is covered.
    for (const lit of new Set(errorReturns)) {
      expect(FAILURE_STATUSES.has(lit)).toBe(true);
    }
  });

  it("isFailureStatus classifies from the structured field only, never prose", () => {
    expect(isFailureStatus("error")).toBe(true);
    expect(isFailureStatus("failed")).toBe(true);
    expect(isFailureStatus("success")).toBe(false);
    expect(isFailureStatus("complete")).toBe(false);
    expect(isFailureStatus("escalated")).toBe(false);
    // Non-string / absent status must not crash or over-flag (Edge Case).
    expect(isFailureStatus(undefined)).toBe(false);
    expect(isFailureStatus(null)).toBe(false);
    expect(isFailureStatus(42)).toBe(false);
    expect(isFailureStatus("this message mentions an error but is a success")).toBe(false);
  });
});

// ===========================================================================
// AC #9 — no secret / PII leakage introduced
// ===========================================================================

describe("no PII widening — message only, never stack (AC #9)", () => {
  it("buildThrownErrorResult emits the error message but NOT the stack trace", () => {
    const err = new Error("boundary failure detail");
    // Force a realistic multi-line stack.
    err.stack = "Error: boundary failure detail\n    at secretPath (/Users/secret/tokens.ts:42:7)";
    const surfaced = buildThrownErrorResult("run_sprint", err) as SurfacedResult;

    expect(surfaced.isError).toBe(true);
    const serialized = JSON.stringify(surfaced);
    expect(serialized).toContain("boundary failure detail");
    // The stack (and the secret path it carries) must never be surfaced.
    expect(serialized).not.toContain("secretPath");
    expect(serialized).not.toContain("/Users/secret/tokens.ts");
    const body = JSON.parse(surfaced.content[0].text);
    expect(body.stack).toBeUndefined();
  });
});
