import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadConfig } from "./config";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when config file does not exist", () => {
    const config = loadConfig(path.join(tmpDir, "nonexistent.json"));
    expect(config.projectsBaseDir).toBe(
      path.join(os.homedir(), "projects")
    );
    expect(config.teamTemplatePath).toBeNull();
  });

  it("loads projectsBaseDir from config file", () => {
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ projectsBaseDir: "/custom/path" })
    );
    const config = loadConfig(configPath);
    expect(config.projectsBaseDir).toBe("/custom/path");
  });

  it("resolves ~ in projectsBaseDir", () => {
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ projectsBaseDir: "~/my-projects" })
    );
    const config = loadConfig(configPath);
    expect(config.projectsBaseDir).toBe(
      path.join(os.homedir(), "my-projects")
    );
  });

  it("uses default projectsBaseDir when not specified in config", () => {
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({}));
    const config = loadConfig(configPath);
    expect(config.projectsBaseDir).toBe(
      path.join(os.homedir(), "projects")
    );
  });

  it("reads teamTemplatePath when provided", () => {
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ teamTemplatePath: "/path/to/TEAM.md" })
    );
    const config = loadConfig(configPath);
    expect(config.teamTemplatePath).toBe("/path/to/TEAM.md");
  });
});
