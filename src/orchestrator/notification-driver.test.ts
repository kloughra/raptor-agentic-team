/**
 * Unit tests — notification-egress driver abstraction + sink (Sprint 16)
 *
 * Covers the `NotificationDriver` factory `resolveDrivers` (AC #4 / AC #8
 * off-switch) and the shipping `JsonlSinkDriver` (NFR-9 durable append-only JSONL,
 * NFR-5 no network egress).
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { NotificationEvent } from "./notifications";
import { JsonlSinkDriver, resolveDrivers } from "./notification-driver";
import { RaptorConfig } from "../config";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-driver-unit-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    event: "complete",
    project: "myapp",
    sprint: 16,
    status: "complete",
    feature: "notification-egress",
    reason: null,
    resumeCommand: null,
    eventKey: "complete:16:sprint:-",
    occurredAt: "2026-07-12T18:04:00.000Z",
    ...overrides,
  };
}

describe("resolveDrivers", () => {
  it("returns a single jsonl-sink driver by default (enabled absent)", () => {
    const cfg: RaptorConfig = { projectsBaseDir: "/tmp/x", teamTemplatePath: null };
    const drivers = resolveDrivers(cfg, path.join(tmpDir, "n.jsonl"));
    expect(drivers).toHaveLength(1);
    expect(drivers[0].name).toBe("jsonl-sink");
    expect(drivers[0]).toBeInstanceOf(JsonlSinkDriver);
  });

  it("returns [] when notifications.enabled === false (hard off-switch)", () => {
    const cfg: RaptorConfig = {
      projectsBaseDir: "/tmp/x",
      teamTemplatePath: null,
      notifications: { enabled: false },
    };
    expect(resolveDrivers(cfg, path.join(tmpDir, "n.jsonl"))).toEqual([]);
  });

  it("returns the sink driver when enabled === true", () => {
    const cfg: RaptorConfig = {
      projectsBaseDir: "/tmp/x",
      teamTemplatePath: null,
      notifications: { enabled: true },
    };
    expect(resolveDrivers(cfg, path.join(tmpDir, "n.jsonl"))).toHaveLength(1);
  });
});

describe("JsonlSinkDriver", () => {
  it("creates parent dirs and appends one JSON line per event, preserving prior lines", () => {
    const sink = path.join(tmpDir, "nested", "deep", "notifications.jsonl");
    const driver = new JsonlSinkDriver(sink);

    driver.send(event({ eventKey: "a" }));
    driver.send(event({ eventKey: "b", event: "failed", status: "failed" }));

    const lines = fs.readFileSync(sink, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect((JSON.parse(lines[0]) as NotificationEvent).eventKey).toBe("a");
    expect((JSON.parse(lines[1]) as NotificationEvent).eventKey).toBe("b");
  });

  it("serializes an event line well under 1 KB (NFR-3 assumption)", () => {
    expect(JSON.stringify(event()).length).toBeLessThan(1024);
  });
});
