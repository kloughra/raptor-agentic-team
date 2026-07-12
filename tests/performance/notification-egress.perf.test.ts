/**
 * Performance / NFR tests — notification-egress (Sprint 16)
 *
 * Spec:         docs/specs/notification-egress.md
 * Architecture: docs/architecture/notification-egress.md (v2 REDESIGN)
 *
 * Non-Functional Requirements exercised here:
 *   • NFR-3 (Latency budget): emission overhead per invocation is one
 *     `fs.appendFileSync` of a sub-1 KB line — target < 5 ms, and NEVER a network
 *     call. These are deliberately generous, machine-independent CI-safe bounds
 *     (not micro-benchmarks): they guard against an accidental blocking / network
 *     / super-linear implementation sneaking into the send path, not exact
 *     nanoseconds.
 *   • NFR-9 (Durability): append-only JSONL — each event is one atomic single-line
 *     append; prior lines stay intact across many appends and never corrupt.
 *
 * Runs against the REAL production `JsonlSinkDriver`; no runner or git needed —
 * sink I/O is local, synchronous, zero-dependency.
 *
 * TDD note: RED at step 3 — `JsonlSinkDriver` / `NotificationEvent` do not exist
 * yet; the Engineer turns this green in step 5.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { NotificationEvent } from "../../src/orchestrator/notifications";
import { JsonlSinkDriver } from "../../src/orchestrator/notification-driver";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-notif-perf-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function event(i: number): NotificationEvent {
  return {
    event: "checkpoint",
    project: "myapp",
    sprint: 16,
    status: "paused",
    feature: "notification-egress",
    reason: "pr-review",
    resumeCommand: `resume_sprint(name="myapp", sprint=16, action="approve")`,
    eventKey: `checkpoint:16:sprint:idx${i}:pr-review`,
    occurredAt: "2026-07-12T18:04:00.000Z",
  };
}

describe("NFR-3: sink append latency budget (generous, CI-safe)", () => {
  it("appends 200 sub-1 KB event lines in well under a blocking/network budget", () => {
    const sink = path.join(tmpDir, "notifications.jsonl");
    const driver = new JsonlSinkDriver(sink);

    const N = 200;
    const start = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      driver.send(event(i));
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

    // Generous machine-independent ceiling: 200 local appends must complete far
    // faster than any per-event network round trip would allow.
    expect(elapsedMs).toBeLessThan(2000);

    // Each serialized event line stays comfortably sub-1 KB (NFR-3 assumption).
    expect(JSON.stringify(event(0)).length).toBeLessThan(1024);
  });
});

describe("NFR-9: durable append-only JSONL — prior lines never corrupt", () => {
  it("preserves every prior line across many appends; each line is well-formed JSON", () => {
    const sink = path.join(tmpDir, "notifications.jsonl");
    const driver = new JsonlSinkDriver(sink);

    const N = 100;
    for (let i = 0; i < N; i++) {
      driver.send(event(i));
    }

    const lines = fs.readFileSync(sink, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(N);
    lines.forEach((line, i) => {
      const parsed = JSON.parse(line) as NotificationEvent;
      expect(parsed.eventKey).toBe(`checkpoint:16:sprint:idx${i}:pr-review`);
    });
  });
});
