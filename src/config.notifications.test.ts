/**
 * Unit tests — loadConfig parses the `notifications` key (Sprint 16)
 *
 * Parsed-vs-declared conformance (AC #7): the `notifications` key MUST be parsed by
 * `loadConfig`, not merely declared on `RaptorConfig`. These tests FAIL against a
 * `loadConfig` that declares but does not parse `notifications` (the
 * `config-keys-parsed-vs-declared` dead-plumbing defect class) — that is the RED
 * verification. Parsing mirrors `parseModels`/`parseTimeouts`: type-guarded,
 * field-wise-dropping, never-throwing.
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { loadConfig, RaptorConfig } from "./config";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-cfg-notif-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(obj: unknown): string {
  const p = path.join(tmpDir, "config.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

describe("loadConfig — notifications parsing (AC 6/7)", () => {
  it("parses enabled + sinkPath from a well-formed config", () => {
    const cfg = loadConfig(writeConfig({ notifications: { enabled: true, sinkPath: "/custom/n.jsonl" } }));
    expect(cfg.notifications).toBeDefined();
    expect(cfg.notifications?.enabled).toBe(true);
    expect(cfg.notifications?.sinkPath).toBe("/custom/n.jsonl");
  });

  it("parses enabled:false (the off-switch)", () => {
    const cfg = loadConfig(writeConfig({ notifications: { enabled: false } }));
    expect(cfg.notifications?.enabled).toBe(false);
  });

  it("absent notifications key → undefined (byte-for-byte pre-feature)", () => {
    expect(loadConfig(writeConfig({ projectsBaseDir: "/tmp/x" })).notifications).toBeUndefined();
  });

  it("a non-object notifications value is ignored entirely and never throws", () => {
    expect(() => loadConfig(writeConfig({ notifications: "nope" }))).not.toThrow();
    expect(loadConfig(writeConfig({ notifications: "nope" })).notifications).toBeUndefined();
    expect(loadConfig(writeConfig({ notifications: ["a"] })).notifications).toBeUndefined();
  });

  it("drops wrong-typed fields field-wise and never throws", () => {
    let parsed!: RaptorConfig;
    expect(
      () => (parsed = loadConfig(writeConfig({ notifications: { enabled: "yes", sinkPath: 5, junk: 1 } })))
    ).not.toThrow();
    expect(parsed.notifications?.enabled).toBeUndefined();
    expect(parsed.notifications?.sinkPath).toBeUndefined();
    expect((parsed.notifications as Record<string, unknown> | undefined)?.junk).toBeUndefined();
  });

  it("drops an empty-string sinkPath (not a usable path)", () => {
    expect(loadConfig(writeConfig({ notifications: { sinkPath: "" } })).notifications?.sinkPath).toBeUndefined();
  });
});
