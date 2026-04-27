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
    expect(allowed).toContain("Read");
    expect(allowed).toContain("Write");
    expect(allowed).toContain("Edit");
    expect(allowed).toContain("Bash(git commit *)");
    expect(allowed).toContain("Bash(npm test *)");
    expect(allowed).toContain("Bash(gh pr create *)");
    // explicitly NOT allowed — destructive surface stays denied
    expect(allowed).not.toContain("Bash(rm");
    expect(allowed).not.toContain("Bash(sudo");
    expect(allowed).not.toContain("Bash(curl");
    expect(allowed).not.toContain("Bash(ssh");
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
