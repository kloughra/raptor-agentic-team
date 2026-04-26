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
    expect(args).toEqual([
      "--print",
      "--system-prompt",
      "sys",
      "--append-system-prompt",
      "ctx",
      "do the thing",
    ]);
    expect(result).toEqual({ output: "done", exitCode: 0 });
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
