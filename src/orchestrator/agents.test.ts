import { EventEmitter } from "events";
import { Readable } from "stream";

const spawnMock = jest.fn();

jest.mock("child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

import { spawnAgent } from "./agents";
import { HARD_CEILING_MS } from "./timeouts";

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

describe("spawnAgent", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it("closes child stdin so claude does not wait for piped input", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("po", "system", "context", "task", "/tmp/project");
    child.stdout.push("ok");
    child.stdout.push(null);
    await flush();
    child.emit("close", 0);
    await promise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  it("invokes the claude CLI with --print and the positional task", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("po", "sys", "ctx", "do the thing", "/tmp/project");
    child.stdout.push("done");
    child.stdout.push(null);
    await flush();
    child.emit("close", 0);
    const result = await promise;

    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("claude");
    expect(args[0]).toBe("--print");
    expect(args[args.length - 1]).toBe("do the thing");
    const sysIdx = args.indexOf("--system-prompt");
    const appendIdx = args.indexOf("--append-system-prompt");
    expect(args[sysIdx + 1]).toBe("sys");
    expect(args[appendIdx + 1]).toBe("ctx");
    expect(result).toEqual({ output: "done", exitCode: 0 });
  });

  it("passes --permission-mode acceptEdits and an --allowedTools list so writes actually persist", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("po", "sys", "ctx", "task", "/tmp/project");
    child.stdout.push("ok");
    child.stdout.push(null);
    await flush();
    child.emit("close", 0);
    await promise;

    const [, args] = spawnMock.mock.calls[0];
    const modeIdx = args.indexOf("--permission-mode");
    const allowIdx = args.indexOf("--allowedTools");
    expect(modeIdx).toBeGreaterThanOrEqual(0);
    expect(args[modeIdx + 1]).toBe("acceptEdits");
    expect(allowIdx).toBeGreaterThanOrEqual(0);

    const allowed = args[allowIdx + 1] as string;
    // Built-in tools
    expect(allowed).toContain("Read");
    expect(allowed).toContain("Write");
    expect(allowed).toContain("Edit");
    // git + gh
    expect(allowed).toContain("Bash(git commit *)");
    expect(allowed).toContain("Bash(git push *)");
    expect(allowed).toContain("Bash(gh pr create *)");
    // JS/TS ecosystem
    expect(allowed).toContain("Bash(npm test *)");
    expect(allowed).toContain("Bash(pnpm *)");
    expect(allowed).toContain("Bash(yarn *)");
    expect(allowed).toContain("Bash(bun *)");
    // Python
    expect(allowed).toContain("Bash(python3 *)");
    expect(allowed).toContain("Bash(pytest *)");
    expect(allowed).toContain("Bash(poetry *)");
    // Rust
    expect(allowed).toContain("Bash(cargo *)");
    // Go
    expect(allowed).toContain("Bash(go *)");
    // Ruby
    expect(allowed).toContain("Bash(bundle *)");
    expect(allowed).toContain("Bash(rspec *)");
    // JVM
    expect(allowed).toContain("Bash(mvn *)");
    expect(allowed).toContain("Bash(gradle *)");
    // Docker
    expect(allowed).toContain("Bash(docker build *)");
    expect(allowed).toContain("Bash(docker compose *)");
    // Generic build
    expect(allowed).toContain("Bash(make *)");

    // explicitly NOT allowed — destructive / privilege / network / cloud / DB
    expect(allowed).not.toContain("Bash(rm");
    expect(allowed).not.toContain("Bash(sudo");
    expect(allowed).not.toContain("Bash(curl");
    expect(allowed).not.toContain("Bash(wget");
    expect(allowed).not.toContain("Bash(ssh");
    expect(allowed).not.toContain("Bash(scp");
    expect(allowed).not.toContain("Bash(chmod");
    expect(allowed).not.toContain("Bash(chown");
    expect(allowed).not.toContain("Bash(kill");
    expect(allowed).not.toContain("Bash(dd ");
    expect(allowed).not.toContain("Bash(aws ");
    expect(allowed).not.toContain("Bash(gcloud ");
    expect(allowed).not.toContain("Bash(kubectl ");
    expect(allowed).not.toContain("Bash(terraform ");
    expect(allowed).not.toContain("Bash(psql ");
    expect(allowed).not.toContain("Bash(mysql ");
  });

  it("returns stderr as output when the process exits non-zero with empty stdout", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("po", "sys", "ctx", "task", "/tmp/project");
    child.stderr.push("boom");
    child.stderr.push(null);
    await flush();
    child.emit("close", 2);
    const result = await promise;

    expect(result).toEqual({ output: "boom", exitCode: 2 });
  });
});

/**
 * CB-3: idle-timeout instead of wall-clock kill (Sprint 12,
 * progress-aware-circuit-breaker, AC 10-12).
 *
 * Per the architecture test-surface map these mechanics are pinned here with
 * fake timers and a fake child process. stdout is the SOLE liveness signal
 * (constraint 9); the hard ceiling is the only defense against a never-idle
 * agent. Data events are emitted synchronously on the fake streams so fake
 * timers and stream delivery cannot deadlock.
 */
describe("spawnAgent — idle timeout & hard ceiling (CB-3)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("resets the idle deadline on every stdout chunk — a streaming agent outlives the idle window (AC 10)", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("qa", "sys", "ctx", "task", "/tmp/project", 1000);

    // Stream a chunk every 600ms; total runtime 3000ms >> the 1000ms idle window.
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

  it("idle-kills a silent agent after the idle window, distinguishable from the legacy wall-clock message (AC 11)", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("qa", "sys", "ctx", "task", "/tmp/project", 1000);
    jest.advanceTimersByTime(1000);
    const result = await promise;

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.exitCode).toBe(1);
    expect(result.killKind).toBe("idle");
    expect(result.output).toBe("agent idle-killed after 1000ms with no stdout output");
    expect(result.output).not.toMatch(/agent timed out after/);
  });

  it("stderr output does NOT reset the idle timer (architecture constraint 9)", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("qa", "sys", "ctx", "task", "/tmp/project", 1000);
    jest.advanceTimersByTime(600);
    child.stderr.emit("data", Buffer.from("warning spew"));
    jest.advanceTimersByTime(400); // 1000ms with zero stdout output
    const result = await promise;

    expect(result.killKind).toBe("idle");
    // Buffered stderr is still preferred as output; the kill message is
    // appended as a suffix line so signature classes always match.
    expect(result.output).toContain("warning spew");
    expect(result.output).toContain("agent idle-killed after 1000ms with no stdout output");
  });

  it("the hard ceiling kills even a continuously streaming agent, with a ceiling-specific message (AC 12)", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    // Idle window = 30 min; stream every 20 min so the idle timer never fires
    // before the 60-min ceiling does.
    const promise = spawnAgent("qa", "sys", "ctx", "task", "/tmp/project", 30 * 60 * 1000);

    jest.advanceTimersByTime(20 * 60 * 1000);
    child.stdout.emit("data", Buffer.from("heartbeat "));
    jest.advanceTimersByTime(20 * 60 * 1000);
    child.stdout.emit("data", Buffer.from("heartbeat "));
    expect(child.kill).not.toHaveBeenCalled();

    jest.advanceTimersByTime(20 * 60 * 1000); // total runtime = HARD_CEILING_MS
    const result = await promise;

    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(result.exitCode).toBe(1);
    expect(result.killKind).toBe("ceiling");
    expect(result.output).toContain(`agent killed at hard ceiling ${HARD_CEILING_MS}ms`);
    expect(result.output).not.toContain("idle-killed");
  });

  it("appends the kill message as a suffix line when buffered output exists, so signature classes still match", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const promise = spawnAgent("qa", "sys", "ctx", "task", "/tmp/project", 1000);
    child.stdout.emit("data", Buffer.from("partial agent chatter..."));
    jest.advanceTimersByTime(1000); // idle window elapses after the last chunk
    const result = await promise;

    expect(result.killKind).toBe("idle");
    expect(result.output).toBe(
      "partial agent chatter...\nagent idle-killed after 1000ms with no stdout output"
    );
  });
});
