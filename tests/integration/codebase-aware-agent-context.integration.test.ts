import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import {
  buildCodebaseSnapshot,
  formatSnapshotForPrompt,
  extractExports,
  CodebaseSnapshot,
  CodebaseContextConfig,
} from "../../src/orchestrator/codebase-context";

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raptor-codebase-ctx-"));
  return dir;
}

function cleanupDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("Codebase-Aware Agent Context", () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = createTempProject();
  });

  afterEach(() => {
    cleanupDir(projectPath);
  });

  describe("buildCodebaseSnapshot", () => {
    it("should include directory tree excluding node_modules and dist", () => {
      // Create source structure
      fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectPath, "src", "index.ts"), "export function main() {}");
      fs.mkdirSync(path.join(projectPath, "node_modules", "foo"), { recursive: true });
      fs.writeFileSync(path.join(projectPath, "node_modules", "foo", "index.js"), "module.exports = {}");
      fs.mkdirSync(path.join(projectPath, "dist"), { recursive: true });
      fs.writeFileSync(path.join(projectPath, "dist", "index.js"), "compiled");

      const snapshot = buildCodebaseSnapshot(projectPath);

      expect(snapshot.directoryTree).toContain("src/");
      expect(snapshot.directoryTree).not.toContain("node_modules");
      expect(snapshot.directoryTree).not.toContain("dist");
    });

    it("should extract TypeScript exports", () => {
      fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(projectPath, "src", "tools.ts"),
        [
          'export function bootstrapProject(name: string) { return name; }',
          'export class ProjectManager {}',
          'export const DEFAULT_CONFIG = {};',
          'export interface Config {}',
          'export type Status = "ok" | "error";',
          'function internal() {}',  // should NOT appear
        ].join("\n")
      );

      const snapshot = buildCodebaseSnapshot(projectPath);

      const toolsExports = snapshot.moduleExports.find((m) => m.path.includes("tools.ts"));
      expect(toolsExports).toBeDefined();
      expect(toolsExports!.exports).toContain("bootstrapProject");
      expect(toolsExports!.exports).toContain("ProjectManager");
      expect(toolsExports!.exports).toContain("DEFAULT_CONFIG");
      expect(toolsExports!.exports).toContain("Config");
      expect(toolsExports!.exports).toContain("Status");
      expect(toolsExports!.exports).not.toContain("internal");
    });

    it("should extract Python exports", () => {
      fs.writeFileSync(
        path.join(projectPath, "app.py"),
        [
          "def handle_request(req):",
          "    pass",
          "",
          "class RequestHandler:",
          "    pass",
          "",
          "def _private():",
          "    pass",
        ].join("\n")
      );

      const snapshot = buildCodebaseSnapshot(projectPath);

      const appExports = snapshot.moduleExports.find((m) => m.path.includes("app.py"));
      expect(appExports).toBeDefined();
      expect(appExports!.exports).toContain("handle_request");
      expect(appExports!.exports).toContain("RequestHandler");
    });

    it("should include key file excerpts capped at per-file limit", () => {
      fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
      const largeContent = "x".repeat(10000);
      fs.writeFileSync(path.join(projectPath, "src", "index.ts"), largeContent);

      const config: CodebaseContextConfig = { maxPerFile: 500 };
      const snapshot = buildCodebaseSnapshot(projectPath, config);

      const excerpt = snapshot.keyFileExcerpts.find((f) => f.path.includes("index.ts"));
      expect(excerpt).toBeDefined();
      expect(excerpt!.content.length).toBeLessThanOrEqual(500);
    });

    it("should respect total size cap", () => {
      fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
      // Create many files
      for (let i = 0; i < 50; i++) {
        fs.writeFileSync(
          path.join(projectPath, "src", `module${i}.ts`),
          `export function fn${i}() { return "${" ".repeat(1000)}"; }`
        );
      }

      const config: CodebaseContextConfig = { maxSize: 5000 };
      const snapshot = buildCodebaseSnapshot(projectPath, config);

      expect(snapshot.totalSize).toBeLessThanOrEqual(5000);
    });

    it("should exclude binary files", () => {
      fs.mkdirSync(path.join(projectPath, "assets"), { recursive: true });
      fs.writeFileSync(path.join(projectPath, "assets", "logo.png"), "fake-binary");
      fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectPath, "src", "index.ts"), "export const x = 1;");

      const snapshot = buildCodebaseSnapshot(projectPath);

      const allPaths = [
        ...snapshot.moduleExports.map((m) => m.path),
        ...snapshot.keyFileExcerpts.map((f) => f.path),
      ];
      expect(allPaths.some((p) => p.endsWith(".png"))).toBe(false);
    });

    it("should respect .gitignore patterns", () => {
      fs.writeFileSync(path.join(projectPath, ".gitignore"), "*.log\ntmp/\n");
      fs.mkdirSync(path.join(projectPath, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectPath, "src", "index.ts"), "export const x = 1;");
      fs.writeFileSync(path.join(projectPath, "debug.log"), "log content");
      fs.mkdirSync(path.join(projectPath, "tmp"), { recursive: true });
      fs.writeFileSync(path.join(projectPath, "tmp", "cache.txt"), "cached");

      const snapshot = buildCodebaseSnapshot(projectPath);

      expect(snapshot.directoryTree).not.toContain("debug.log");
      expect(snapshot.directoryTree).not.toContain("tmp/");
    });

    it("should include dependency list", () => {
      fs.writeFileSync(
        path.join(projectPath, "package.json"),
        JSON.stringify({
          dependencies: { express: "^4.0.0" },
          devDependencies: { jest: "^29.0.0", typescript: "^5.0.0" },
        })
      );

      const snapshot = buildCodebaseSnapshot(projectPath);

      expect(snapshot.dependencies).toContain("express");
      expect(snapshot.dependencies).toContain("jest");
      expect(snapshot.dependencies).toContain("typescript");
    });
  });

  describe("extractExports", () => {
    it("should extract TS/JS exports from content", () => {
      const content = [
        'export function foo() {}',
        'export class Bar {}',
        'export const BAZ = 1;',
        'export default function() {}',
        'export interface IConfig {}',
        'export type MyType = string;',
      ].join("\n");

      const exports = extractExports(content, "test.ts");
      expect(exports).toContain("foo");
      expect(exports).toContain("Bar");
      expect(exports).toContain("BAZ");
      expect(exports).toContain("IConfig");
      expect(exports).toContain("MyType");
    });

    it("should extract Python defs and classes", () => {
      const content = [
        "def process(data):",
        "    return data",
        "",
        "class Processor:",
        "    pass",
      ].join("\n");

      const exports = extractExports(content, "module.py");
      expect(exports).toContain("process");
      expect(exports).toContain("Processor");
    });
  });

  describe("formatSnapshotForPrompt", () => {
    it("should produce a formatted markdown section", () => {
      const snapshot: CodebaseSnapshot = {
        directoryTree: "├── src/\n│   └── index.ts",
        moduleExports: [{ path: "src/index.ts", exports: ["main", "Config"] }],
        keyFileExcerpts: [{ path: "src/index.ts", content: "export function main() {}" }],
        dependencies: ["express", "typescript"],
        totalSize: 500,
      };

      const formatted = formatSnapshotForPrompt(snapshot);

      expect(formatted).toContain("## Codebase Context");
      expect(formatted).toContain("### Directory Tree");
      expect(formatted).toContain("### Module Exports");
      expect(formatted).toContain("src/index.ts");
      expect(formatted).toContain("main");
      expect(formatted).toContain("### Key Files");
      expect(formatted).toContain("### Dependencies");
      expect(formatted).toContain("express");
    });

    it("should handle empty snapshot gracefully", () => {
      const snapshot: CodebaseSnapshot = {
        directoryTree: "",
        moduleExports: [],
        keyFileExcerpts: [],
        dependencies: [],
        totalSize: 0,
      };

      const formatted = formatSnapshotForPrompt(snapshot);

      expect(formatted).toContain("## Codebase Context");
      // Should not throw
    });
  });
});
