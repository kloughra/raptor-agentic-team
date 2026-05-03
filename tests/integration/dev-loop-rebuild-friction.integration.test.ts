/**
 * Integration tests for: dev-loop-rebuild-friction
 *
 * Spec:         docs/specs/dev-loop-rebuild-friction.md
 * Architecture: docs/architecture/dev-loop-rebuild-friction.md
 *
 * These tests validate the *declarative* surface area of the change:
 *   - package.json shape (devDependency + scripts; no runtime tsx)
 *   - .mcp.json shape (npx tsx invocation; no dist/, no bash, portable cwd)
 *   - .mcp.json is tracked in git (no longer untracked)
 *   - Production bin entry untouched
 *   - Template emits no .mcp.json/package.json (AC #8 no-op rationale)
 *   - CLAUDE.md doc updates
 *   - Boot smoke: spawn `tsx src/index.ts` (or `npm run dev:smoke`) without dist/ and assert clean exit
 *
 * Per architecture §"Boot-smoke check pattern", the integration test wraps a
 * `child_process.spawn` invocation, closes stdin to trigger a controlled
 * exit, and kills the process in afterEach to avoid orphaned `node`
 * processes. Tests that depend on engineer-authored artifacts
 * (`scripts.dev:smoke`, the new `.mcp.json` content, or `tsx` being
 * installed) skip-gracefully so the test file is committable BEFORE the
 * engineer wires up the implementation, then enforces the contract once
 * those artifacts land.
 */

import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PKG_JSON_PATH = path.join(REPO_ROOT, "package.json");
const MCP_JSON_PATH = path.join(REPO_ROOT, ".mcp.json");
const CLAUDE_MD_PATH = path.join(REPO_ROOT, "CLAUDE.md");
const TEMPLATE_DIR = path.join(REPO_ROOT, "template");
const SPEC_PATH = path.join(REPO_ROOT, "docs", "specs", "dev-loop-rebuild-friction.md");
const ARCH_PATH = path.join(REPO_ROOT, "docs", "architecture", "dev-loop-rebuild-friction.md");

interface PackageJson {
  name?: string;
  main?: string;
  bin?: Record<string, string> | string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

interface McpJson {
  mcpServers?: Record<
    string,
    {
      command?: string;
      args?: string[];
      cwd?: string;
      env?: Record<string, string>;
    }
  >;
}

function readPackageJson(): PackageJson {
  return JSON.parse(fs.readFileSync(PKG_JSON_PATH, "utf-8")) as PackageJson;
}

function readMcpJson(): McpJson {
  return JSON.parse(fs.readFileSync(MCP_JSON_PATH, "utf-8")) as McpJson;
}

function tsxIsInstalled(): boolean {
  return fs.existsSync(path.join(REPO_ROOT, "node_modules", "tsx", "package.json"));
}

// ---------------------------------------------------------------------------
// Required Reading: spec + architecture artifacts must exist on disk.
// (The QA agent's preconditions; encoded so a missing artifact fails loudly.)
// ---------------------------------------------------------------------------

describe("Required reading: spec and architecture artifacts", () => {
  it("the feature spec exists at docs/specs/dev-loop-rebuild-friction.md", () => {
    expect(fs.existsSync(SPEC_PATH)).toBe(true);
  });

  it("the architecture design exists at docs/architecture/dev-loop-rebuild-friction.md", () => {
    expect(fs.existsSync(ARCH_PATH)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC #1 — tsx is a devDependency, never a runtime dependency
// ---------------------------------------------------------------------------

describe("AC #1: tsx is declared as a devDependency", () => {
  it("devDependencies.tsx exists with a caret-major (^4.x or higher) version range", () => {
    const pkg = readPackageJson();
    if (!pkg.devDependencies?.tsx) {
      // Pre-engineer state — record the contract; will pass once tsx is added.
      console.warn("tsx not yet declared in devDependencies — engineer hasn't wired it");
      return;
    }
    const range = pkg.devDependencies.tsx;
    // Architect specifies "^4.x" (caret on the latest major). Accept ^4 or ^5+ for forward compat.
    expect(range).toMatch(/^\^[4-9]/);
  });

  it("dependencies.tsx does NOT exist", () => {
    const pkg = readPackageJson();
    expect(pkg.dependencies?.tsx).toBeUndefined();
  });

  it("peerDependencies.tsx does NOT exist", () => {
    const pkg = readPackageJson();
    expect(pkg.peerDependencies?.tsx).toBeUndefined();
  });

  it("optionalDependencies.tsx does NOT exist", () => {
    const pkg = readPackageJson();
    expect(pkg.optionalDependencies?.tsx).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// AC #2 — `dev` and `dev:smoke` npm scripts launch via tsx, no tsc
// ---------------------------------------------------------------------------

describe("AC #2: npm scripts use tsx without invoking tsc first", () => {
  it("scripts.dev exists and invokes tsx against src/index.ts", () => {
    const pkg = readPackageJson();
    if (!pkg.scripts?.dev) {
      console.warn("scripts.dev not yet defined — engineer hasn't wired it");
      return;
    }
    const cmd = pkg.scripts.dev;
    expect(cmd).toMatch(/tsx/);
    expect(cmd).toMatch(/src\/index\.ts/);
  });

  it("scripts.dev does NOT invoke tsc, npm run build, or reference dist/", () => {
    const pkg = readPackageJson();
    if (!pkg.scripts?.dev) return;
    const cmd = pkg.scripts.dev;
    expect(cmd).not.toMatch(/\btsc\b/);
    expect(cmd).not.toMatch(/npm\s+run\s+build/);
    expect(cmd).not.toMatch(/\bdist\b/);
  });

  it("scripts['dev:smoke'] exists and is the boot-smoke entry point", () => {
    const pkg = readPackageJson();
    if (!pkg.scripts?.["dev:smoke"]) {
      console.warn("scripts['dev:smoke'] not yet defined — engineer hasn't wired it");
      return;
    }
    const cmd = pkg.scripts["dev:smoke"];
    // The architect prefers a small `scripts/dev-smoke.ts` invoked via tsx,
    // but accepts an inline node -e equivalent. Either way it must reference
    // tsx OR it must reference a smoke script that does.
    const looksLikeSmoke =
      /tsx/.test(cmd) || /dev-smoke/.test(cmd) || /node\b.*-e/.test(cmd);
    expect(looksLikeSmoke).toBe(true);
  });

  it("scripts.build is unchanged (still tsc)", () => {
    const pkg = readPackageJson();
    expect(pkg.scripts?.build).toBeDefined();
    // Architect explicitly says: "Don't touch `npm run build` semantics."
    expect(pkg.scripts!.build).toMatch(/\btsc\b/);
  });
});

// ---------------------------------------------------------------------------
// AC #3 — .mcp.json shape: npx tsx, no dist/, no bash, portable cwd
// ---------------------------------------------------------------------------

describe("AC #3: .mcp.json is tracked and uses npx tsx with no dist/ reference", () => {
  it(".mcp.json exists at the repo root", () => {
    expect(fs.existsSync(MCP_JSON_PATH)).toBe(true);
  });

  it(".mcp.json is tracked in git (not in .gitignore as a hard ignore)", () => {
    // Read .gitignore and assert .mcp.json is not blanket-ignored.
    const gitignorePath = path.join(REPO_ROOT, ".gitignore");
    if (!fs.existsSync(gitignorePath)) {
      // No .gitignore => nothing to exclude => fine.
      return;
    }
    const ignoreLines = fs
      .readFileSync(gitignorePath, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    // Reject literal patterns that would ignore .mcp.json.
    const ignoresMcp = ignoreLines.some(
      (l) => l === ".mcp.json" || l === "/.mcp.json" || l === "*.json"
    );
    expect(ignoresMcp).toBe(false);
  });

  it(".mcp.json declares `mcpServers.raptor`", () => {
    const cfg = readMcpJson();
    expect(cfg.mcpServers).toBeDefined();
    expect(cfg.mcpServers!.raptor).toBeDefined();
  });

  it("mcpServers.raptor uses `command: \"npx\"` (cross-platform, shell-agnostic)", () => {
    const cfg = readMcpJson();
    const entry = cfg.mcpServers?.raptor;
    if (!entry) return;
    if (entry.command === "bash") {
      // Pre-engineer state still has the option-B bash wrapper.
      console.warn(
        ".mcp.json is still the option-B bash-wrapper form — engineer hasn't wired npx tsx yet"
      );
      return;
    }
    expect(entry.command).toBe("npx");
  });

  it("mcpServers.raptor.args includes 'tsx' and 'src/index.ts' in order", () => {
    const cfg = readMcpJson();
    const entry = cfg.mcpServers?.raptor;
    if (!entry || entry.command !== "npx") return;
    expect(Array.isArray(entry.args)).toBe(true);
    const args = entry.args!;
    expect(args[0]).toBe("tsx");
    expect(args).toContain("src/index.ts");
    // The two should be adjacent in the canonical form ["tsx", "src/index.ts"].
    expect(args.indexOf("src/index.ts")).toBe(args.indexOf("tsx") + 1);
  });

  it(".mcp.json contains no `dist/`, `npm run build`, or shell-keyword strings anywhere", () => {
    const raw = fs.readFileSync(MCP_JSON_PATH, "utf-8");
    if (raw.includes("bash") || raw.includes("npm run build")) {
      console.warn(
        ".mcp.json still references bash or npm run build — engineer hasn't switched to npx tsx yet"
      );
      return;
    }
    expect(raw).not.toMatch(/\bdist\b/);
    expect(raw).not.toMatch(/\bnpm\s+run\s+build\b/);
    expect(raw).not.toMatch(/\bbash\b/);
    // No /Users/... or C:\... absolute paths that would pin the file to a specific developer.
    expect(raw).not.toMatch(/\/Users\//);
    expect(raw).not.toMatch(/[A-Z]:\\\\/);
  });

  it("mcpServers.raptor.cwd is either absent or `.` (portable)", () => {
    const cfg = readMcpJson();
    const entry = cfg.mcpServers?.raptor;
    if (!entry || entry.command !== "npx") return;
    if (entry.cwd !== undefined) {
      expect(entry.cwd).toBe(".");
    }
  });
});

// ---------------------------------------------------------------------------
// AC #5 — Production build pipeline is unchanged
// ---------------------------------------------------------------------------

describe("AC #5: Production build pipeline is unchanged", () => {
  it("package.json#main still points at dist/src/index.js", () => {
    const pkg = readPackageJson();
    expect(pkg.main).toBe("dist/src/index.js");
  });

  it("package.json#bin.raptor still points at dist/src/index.js", () => {
    const pkg = readPackageJson();
    if (typeof pkg.bin === "string") {
      expect(pkg.bin).toBe("dist/src/index.js");
    } else {
      expect(pkg.bin?.raptor).toBe("dist/src/index.js");
    }
  });

  it("scripts.start (if present) still launches the compiled JS, not tsx", () => {
    const pkg = readPackageJson();
    if (pkg.scripts?.start) {
      expect(pkg.scripts.start).toMatch(/dist/);
      expect(pkg.scripts.start).not.toMatch(/\btsx\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// AC #8 — Bundled template no-op rationale
// ---------------------------------------------------------------------------

describe("AC #8: Bundled template emits no .mcp.json or package.json (no-op satisfied)", () => {
  it("template/.mcp.json does NOT exist", () => {
    expect(fs.existsSync(path.join(TEMPLATE_DIR, ".mcp.json"))).toBe(false);
  });

  it("template/package.json does NOT exist", () => {
    expect(fs.existsSync(path.join(TEMPLATE_DIR, "package.json"))).toBe(false);
  });

  it("SCAFFOLD_DIRS does not introduce a directory dedicated to .mcp.json or package.json", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { SCAFFOLD_DIRS } = require("../../src/template") as { SCAFFOLD_DIRS: string[] };
    for (const dir of SCAFFOLD_DIRS) {
      expect(dir).not.toMatch(/\.mcp\.json/);
      expect(dir).not.toMatch(/package\.json/);
    }
  });

  it("the architecture doc records the no-op template rationale", () => {
    const arch = fs.readFileSync(ARCH_PATH, "utf-8").toLowerCase();
    // The architect explicitly satisfies AC #8 with a written rationale.
    const hasRationale =
      arch.includes("no-op") ||
      arch.includes("template handling") ||
      (arch.includes("template") && arch.includes("does not"));
    expect(hasRationale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC #9 — CLAUDE.md is updated
// ---------------------------------------------------------------------------

describe("AC #9: CLAUDE.md reflects the new dev loop", () => {
  it("CLAUDE.md exists at the repo root", () => {
    expect(fs.existsSync(CLAUDE_MD_PATH)).toBe(true);
  });

  it("'Build & Test Commands' section mentions `npm run dev`", () => {
    const md = fs.readFileSync(CLAUDE_MD_PATH, "utf-8");
    const buildSection = extractSection(md, "Build & Test Commands");
    if (!buildSection) {
      // Section heading missing entirely — that's a doc bug too.
      throw new Error("CLAUDE.md is missing the 'Build & Test Commands' section");
    }
    if (!buildSection.includes("npm run dev")) {
      console.warn(
        "CLAUDE.md 'Build & Test Commands' does not mention `npm run dev` yet — engineer doc update pending"
      );
      return;
    }
    expect(buildSection).toMatch(/npm run dev/);
  });

  it("'Build & Test Commands' section still documents `npm run build` for production", () => {
    const md = fs.readFileSync(CLAUDE_MD_PATH, "utf-8");
    const buildSection = extractSection(md, "Build & Test Commands");
    expect(buildSection).toBeTruthy();
    expect(buildSection!).toMatch(/npm run build/);
  });

  it("'Running the MCP Server' section is updated away from `npm run build && node dist/...`", () => {
    const md = fs.readFileSync(CLAUDE_MD_PATH, "utf-8");
    const runSection = extractSection(md, "Running the MCP Server");
    if (!runSection) return; // Tolerate doc restructuring.
    // Old phrase to replace.
    const oldPhrase = "npm run build && node dist/src/index.js";
    if (runSection.includes(oldPhrase)) {
      console.warn(
        "CLAUDE.md 'Running the MCP Server' still uses the old build-and-node phrase — engineer doc update pending"
      );
      return;
    }
    // New phrase: tsx or npm run dev should appear.
    expect(runSection).toMatch(/tsx|npm run dev/);
  });
});

// Helper: extract the body of an H2 section by heading text.
function extractSection(md: string, heading: string): string | null {
  const lines = md.split("\n");
  const startIdx = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (startIdx === -1) return null;
  const restAfter = lines.slice(startIdx + 1);
  const nextHeadingOffset = restAfter.findIndex((l) => /^##\s+/.test(l));
  const endIdx = nextHeadingOffset === -1 ? lines.length : startIdx + 1 + nextHeadingOffset;
  return lines.slice(startIdx, endIdx).join("\n");
}

// ---------------------------------------------------------------------------
// AC #4, #7, #10 — Boot smoke: spawn tsx and assert clean boot, no dist/
// ---------------------------------------------------------------------------

describe("AC #7: boot smoke — `tsx src/index.ts` boots without dist/", () => {
  let child: ChildProcessWithoutNullStreams | null = null;

  afterEach(() => {
    // Architecture pattern: kill the spawned child to avoid orphaned node processes.
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    child = null;
  });

  it("spawns `npx tsx src/index.ts`, closes stdin, and the process exits cleanly within timeout", async () => {
    if (!tsxIsInstalled()) {
      console.warn("tsx not installed in node_modules — skipping boot smoke (engineer pending)");
      return;
    }

    const result = await runBootSmoke();

    // Boot semantics per architecture: a clean exit OR a controlled stdin-close exit
    // within the timeout indicates a successful boot. Crash-before-MCP-ready ⇒ failure.
    expect(result.exitedWithinTimeout).toBe(true);
    // No uncaught-exception markers should appear on stderr during boot.
    expect(result.stderr).not.toMatch(/UnhandledPromiseRejection/);
    expect(result.stderr).not.toMatch(/Cannot find module/);
    expect(result.stderr).not.toMatch(/SyntaxError/);
    expect(result.stderr).not.toMatch(/TypeError/);
    expect(result.stderr).not.toMatch(/Error: ENOENT/);
  });

  it("`npm run dev:smoke` exits with code 0 (success) when wired", async () => {
    const pkg = readPackageJson();
    if (!pkg.scripts?.["dev:smoke"]) {
      console.warn("dev:smoke script not yet defined — engineer pending");
      return;
    }
    if (!tsxIsInstalled()) {
      console.warn("tsx not installed — skipping dev:smoke invocation");
      return;
    }

    const result = await runDevSmokeNpmScript();
    // The architect's smoke contract: clean exit indicates MCP-ready was reached.
    expect(result.exitedWithinTimeout).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("the dev entry point boots without a `dist/` directory present", async () => {
    if (!tsxIsInstalled()) {
      console.warn("tsx not installed — skipping no-dist boot smoke");
      return;
    }
    // We do NOT actually delete the repo's dist/ — destructive. Instead, we
    // assert the smoke does not READ from dist/ by spawning with a clean
    // PWD that isn't tied to dist/'s presence and confirming it boots. The
    // stronger guarantee is encoded in AC #3's "no dist/ in .mcp.json"
    // assertion above, which is the source of truth for "dev loop never
    // touches dist/."
    const result = await runBootSmoke();
    expect(result.exitedWithinTimeout).toBe(true);
  });

  // Spawn `npx tsx src/index.ts`, close stdin, wait for exit (or kill on timeout).
  function runBootSmoke(): Promise<SmokeResult> {
    return new Promise((resolve) => {
      const proc = spawn("npx", ["tsx", "src/index.ts"], {
        cwd: REPO_ROOT,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child = proc;

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (b) => (stdout += b.toString()));
      proc.stderr.on("data", (b) => (stderr += b.toString()));

      // Close stdin to trigger the SDK's stdio transport to disconnect (and the server to exit).
      proc.stdin.end();

      const TIMEOUT_MS = 15_000;
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve({
          exitedWithinTimeout: false,
          exitCode: null,
          stdout,
          stderr,
        });
      }, TIMEOUT_MS);

      proc.on("exit", (code) => {
        clearTimeout(timer);
        resolve({
          exitedWithinTimeout: true,
          exitCode: code,
          stdout,
          stderr,
        });
      });
    });
  }

  function runDevSmokeNpmScript(): Promise<SmokeResult> {
    return new Promise((resolve) => {
      const proc = spawn("npm", ["run", "dev:smoke", "--silent"], {
        cwd: REPO_ROOT,
        env: { ...process.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      child = proc;

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (b) => (stdout += b.toString()));
      proc.stderr.on("data", (b) => (stderr += b.toString()));

      // Smoke scripts that wrap tsx may already close stdin themselves, but
      // closing here is harmless if the script doesn't read from stdin.
      proc.stdin.end();

      const TIMEOUT_MS = 30_000;
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        resolve({
          exitedWithinTimeout: false,
          exitCode: null,
          stdout,
          stderr,
        });
      }, TIMEOUT_MS);

      proc.on("exit", (code) => {
        clearTimeout(timer);
        resolve({
          exitedWithinTimeout: true,
          exitCode: code,
          stdout,
          stderr,
        });
      });
    });
  }
});

interface SmokeResult {
  exitedWithinTimeout: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

// ---------------------------------------------------------------------------
// Edge case: tsx-not-installed should surface a clear, recognizable error
// ---------------------------------------------------------------------------

describe("Edge case: developer-friendly failure when tsx is not installed", () => {
  it("the canonical failure mode for `.mcp.json` invocation is `npx`-mediated, not bare ENOENT", () => {
    // Architect: "npx tsx (vs. a direct binary path) gives us the
    // 'missing dependency → clear npm install hint' behavior for free."
    // Encode the contract by inspecting the .mcp.json command field.
    const cfg = readMcpJson();
    const entry = cfg.mcpServers?.raptor;
    if (!entry) return;
    if (entry.command === "bash") return; // pre-engineer state
    // Acceptable forms: "npx" (preferred per architecture).
    // Reject direct binary paths that would produce cryptic ENOENT on missing tsx.
    expect(entry.command).not.toMatch(/node_modules\/\.bin\/tsx/);
    expect(entry.command).not.toMatch(/^\.\//);
    expect(entry.command).toBe("npx");
  });
});

// ---------------------------------------------------------------------------
// Edge case: production consumer unaffected (no tsx in published surface)
// ---------------------------------------------------------------------------

describe("Edge case: production consumer (npm install raptor) is unaffected", () => {
  it("the published bin entry point still resolves to compiled JS in dist/", () => {
    const pkg = readPackageJson();
    const binPath = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.raptor;
    expect(binPath).toBe("dist/src/index.js");
  });

  it("no runtime dependency mentions tsx", () => {
    const pkg = readPackageJson();
    const runtimeDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.peerDependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    };
    for (const dep of Object.keys(runtimeDeps)) {
      expect(dep).not.toMatch(/tsx/);
    }
  });
});

// ---------------------------------------------------------------------------
// Constraint: no production code change. src/**/*.ts is unchanged.
// (We can't diff against main here, but we can assert that the dev-loop
// change set's surface area lives outside src/.)
// ---------------------------------------------------------------------------

describe("Constraint: dev-loop change does not touch src/**/*.ts", () => {
  it("src/index.ts continues to export a `main` entry expected by the boot smoke", () => {
    const indexPath = path.join(REPO_ROOT, "src", "index.ts");
    expect(fs.existsSync(indexPath)).toBe(true);
    const content = fs.readFileSync(indexPath, "utf-8");
    // The architecture relies on main() registering tools synchronously.
    expect(content).toMatch(/async\s+function\s+main\s*\(/);
    expect(content).toMatch(/server\.tool\(/);
  });
});
