/**
 * Unit tests — adversarial-verifier-review-gate (Sprint 14), Part 2 argv seam.
 *
 * Spec:         docs/specs/adversarial-verifier-review-gate.md (AC 5, 6, 7)
 * Architecture: docs/architecture/adversarial-verifier-review-gate.md
 *               (Handoff to QA #1: "Part 2 argv (agents.test.ts)")
 *
 * PRODUCTION SEAM (TEAM.md QA rule 12 / AC 16): these tests drive the REAL
 * `spawnAgent` argv assembly against a fake child process — never a test-local
 * copy of the arg array. The load-bearing `--allowedTools … -- taskDescription`
 * tail (PR #18) and the Sprint 12 idle-timer/hard-ceiling machinery must not
 * regress when a model is set.
 *
 * File is named by feature slug (not appended to the frozen `agents.test.ts`)
 * so it runs under the sprint's scoped test command
 *   npx jest --testPathPattern="adversarial-verifier-review-gate"
 * and so the RED signature-change (the new optional `model` param) does not
 * knock the existing green `agents.test.ts` out at compile time.
 *
 * TDD note: RED at step 3 — `spawnAgent` has no `model` parameter on `main`, so
 * the with-model tests below cannot even compile until the Engineer adds the
 * optional 7th param, and the `--model` assertions fail until it is plumbed to
 * argv. RED-verification notes are recorded per constraint-guarding test.
 * Tests tagged [no-regression] pass both before and after and are not
 * constraint-guarding.
 */

import { EventEmitter } from "events";
import { Readable } from "stream";

const spawnMock = jest.fn();

jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { spawnAgent } from "./agents";

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: jest.Mock;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.kill = jest.fn();
  return child;
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

const VERIFIER_MODEL = "claude-verifier-model";

describe("spawnAgent — model plumbing (Part 2, AC 5/6)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("inserts --model <value> when a model is provided (AC 5)", async () => {
    // RED-verification: fails on `main` — `spawnAgent` takes no model param and
    // never emits `--model`, so the token is absent from argv pre-change.
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("qa", "sys", "ctx", "run the suite", "/tmp/p", undefined, VERIFIER_MODEL);
    child.stdout.push("ok");
    child.stdout.push(null);
    await flush();
    child.emit("close", 0);
    await promise;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(args[modelIdx + 1]).toBe(VERIFIER_MODEL);
  });

  it("preserves the load-bearing tail with a model set: allowedTools → -- → task (AC 6)", async () => {
    // RED-verification: guards the PR #18 contract. Fails if `--model` is
    // inserted between `--allowedTools` and the tool list, or if the terminal
    // `--`/positional ordering is disturbed by the insertion.
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("qa", "sys", "ctx", "do the thing", "/tmp/p", undefined, VERIFIER_MODEL);
    child.stdout.push("done");
    child.stdout.push(null);
    await flush();
    child.emit("close", 0);
    await promise;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];

    // --allowedTools is immediately followed ONLY by the tool list — never the
    // model value or the prompt.
    const allowIdx = args.indexOf("--allowedTools");
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    const toolList = args[allowIdx + 1];
    expect(toolList).toContain("Read");
    expect(toolList).not.toBe(VERIFIER_MODEL);
    expect(toolList).not.toBe("do the thing");

    // The end-of-options separator is present and the task is the LAST element.
    const dashDashIdx = args.indexOf("--");
    expect(dashDashIdx).toBeGreaterThanOrEqual(0);
    expect(args[args.length - 1]).toBe("do the thing");
    expect(dashDashIdx).toBeLessThan(args.length - 1);

    // --model, when present, sits ahead of the frozen tail (before --allowedTools).
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeLessThan(allowIdx);
  });

  it("omits --model entirely when no model is provided — byte-identical argv (AC 5, backward compat)", async () => {
    // RED-verification: fails if the implementation unconditionally emits
    // `--model` (e.g. `--model undefined`). Also the byte-identical guarantee:
    // the no-model argv must equal today's array exactly.
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("po", "sys", "ctx", "task", "/tmp/p");
    child.stdout.push("ok");
    child.stdout.push(null);
    await flush();
    child.emit("close", 0);
    await promise;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain("--model");
    // The exact pre-feature array (documented in the architecture argv block).
    expect(args[0]).toBe("--print");
    expect(args[1]).toBe("--permission-mode");
    expect(args[2]).toBe("acceptEdits");
    expect(args[3]).toBe("--allowedTools");
    expect(args[5]).toBe("--system-prompt");
    expect(args[7]).toBe("--append-system-prompt");
    expect(args[9]).toBe("--");
    expect(args[10]).toBe("task");
    expect(args).toHaveLength(11);
  });

  it("[no-regression] a passed-through undefined model behaves like no model", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("po", "sys", "ctx", "task", "/tmp/p", 5000, undefined);
    child.stdout.push("ok");
    child.stdout.push(null);
    await flush();
    child.emit("close", 0);
    await promise;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain("--model");
    expect(args[args.length - 1]).toBe("task");
  });
});

describe("spawnAgent — idle/ceiling not regressed with a model set (Part 2, AC 7)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("idle-kills a silent agent identically when a model is provided (AC 7)", async () => {
    // RED-verification: guards that inserting `--model` does not disturb the
    // Sprint 12 idle-timer wiring. Would fail if the model plumbing reordered
    // args such that `timeoutMs` no longer reached the idle timer.
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("qa", "sys", "ctx", "task", "/tmp/p", 1000, VERIFIER_MODEL);
    jest.advanceTimersByTime(1000);
    const result = await promise;

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.exitCode).toBe(1);
    expect(result.killKind).toBe("idle");
    expect(result.output).toBe("agent idle-killed after 1000ms with no stdout output");
  });

  it("a streaming agent with a model survives its idle window and exits cleanly (AC 7)", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("qa", "sys", "ctx", "task", "/tmp/p", 1000, VERIFIER_MODEL);
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(600);
      child.stdout.emit("data", Buffer.from("tick "));
    }
    expect(child.kill).not.toHaveBeenCalled();

    child.emit("close", 0);
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.killKind).toBeUndefined();
  });
});
