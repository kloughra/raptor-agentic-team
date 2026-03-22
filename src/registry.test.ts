import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Registry } from "./registry";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-registry-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Registry", () => {
  it("creates projects.json on first write", async () => {
    const registryPath = path.join(tmpDir, "projects.json");
    expect(fs.existsSync(registryPath)).toBe(false);

    const registry = new Registry(registryPath);
    await registry.addProject({
      name: "test",
      slug: "test",
      description: "test project",
      path: "/tmp/test",
      createdAt: new Date().toISOString(),
    });

    expect(fs.existsSync(registryPath)).toBe(true);
  });

  it("returns empty array when no projects exist", async () => {
    const registry = new Registry(path.join(tmpDir, "projects.json"));
    const projects = await registry.listProjects();
    expect(projects).toEqual([]);
  });

  it("persists project entries across reads", async () => {
    const registryPath = path.join(tmpDir, "projects.json");
    const registry = new Registry(registryPath);

    await registry.addProject({
      name: "app-one",
      slug: "app-one",
      description: "First app",
      path: "/tmp/app-one",
      createdAt: new Date().toISOString(),
    });
    await registry.addProject({
      name: "app-two",
      slug: "app-two",
      description: "Second app",
      path: "/tmp/app-two",
      createdAt: new Date().toISOString(),
    });

    // Read from a fresh instance to verify persistence
    const freshRegistry = new Registry(registryPath);
    const projects = await freshRegistry.listProjects();
    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.name)).toContain("app-one");
    expect(projects.map((p) => p.name)).toContain("app-two");
  });

  it("detects duplicate project names", async () => {
    const registry = new Registry(path.join(tmpDir, "projects.json"));
    await registry.addProject({
      name: "my-app",
      slug: "my-app",
      description: "An app",
      path: "/tmp/my-app",
      createdAt: new Date().toISOString(),
    });

    await expect(
      registry.addProject({
        name: "my-app",
        slug: "my-app",
        description: "Duplicate",
        path: "/tmp/my-app-2",
        createdAt: new Date().toISOString(),
      })
    ).rejects.toThrow(/already exists/);
  });

  it("finds a project by name", async () => {
    const registry = new Registry(path.join(tmpDir, "projects.json"));
    await registry.addProject({
      name: "my-app",
      slug: "my-app",
      description: "An app",
      path: "/tmp/my-app",
      createdAt: new Date().toISOString(),
    });

    const found = await registry.findProject("my-app");
    expect(found).toBeDefined();
    expect(found!.name).toBe("my-app");

    const notFound = await registry.findProject("ghost");
    expect(notFound).toBeUndefined();
  });

  it("checks if project exists", async () => {
    const registry = new Registry(path.join(tmpDir, "projects.json"));
    await registry.addProject({
      name: "my-app",
      slug: "my-app",
      description: "An app",
      path: "/tmp/my-app",
      createdAt: new Date().toISOString(),
    });

    expect(await registry.projectExists("my-app")).toBe(true);
    expect(await registry.projectExists("nope")).toBe(false);
  });
});
