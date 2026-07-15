import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { Role } from "./orchestrator/workflow";

export interface RaptorConfig {
  projectsBaseDir: string;
  teamTemplatePath: string | null;
  dinoNames?: Partial<Record<string, { species?: string; nickname?: string; emoji?: string }>>;
  timeouts?: {
    default?: number;
    stepOverrides?: Record<string, number>;
  };
  /**
   * Per-role model selection (adversarial-verifier-review-gate, Sprint 14 —
   * Part 2). Lets the verifying roles (QA) run on a different `claude --model`
   * than the generating role (Engineer). Absent key ⇒ default model everywhere
   * (byte-identical to pre-feature behavior). Parsed in `loadConfig` — NOT
   * merely declared — to avoid the `config-keys-parsed-vs-declared` defect.
   */
  models?: {
    default?: string;
    byRole?: Partial<Record<Role, string>>;
  };
  testConfig?: {
    framework?: string;
    testCommand?: string;
    scopedPattern?: string;
  };
  codebaseContext?: {
    maxSize?: number;
    maxPerFile?: number;
    excludePatterns?: string[];
  };
  artifactInjection?: {
    customRequirements?: Record<string, Array<{ pattern: string; label: string; required: boolean }>>;
    maxArtifactSize?: number;
  };
  scopeNarrowing?: {
    enabled?: boolean;
    disabledSteps?: string[];
  };
  /**
   * notification-egress (Sprint 16). Out-of-band sprint lifecycle notifications
   * via a local append-only JSONL sink (v2 REDESIGN — zero network egress).
   * Absent key ⇒ default-on audit sink; `enabled: false` ⇒ byte-for-byte
   * pre-feature parity. Parsed in `loadConfig` via `parseNotifications` — NOT
   * merely declared — to avoid the `config-keys-parsed-vs-declared` defect.
   */
  notifications?: {
    enabled?: boolean;
    sinkPath?: string;
  };
}

const DEFAULT_PROJECTS_BASE_DIR = path.join(os.homedir(), "workspace");

export function loadConfig(configPath: string): RaptorConfig {
  const defaults: RaptorConfig = {
    projectsBaseDir: DEFAULT_PROJECTS_BASE_DIR,
    teamTemplatePath: null,
  };

  if (!fs.existsSync(configPath)) {
    return defaults;
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(raw);

  return {
    projectsBaseDir: parsed.projectsBaseDir
      ? resolveHome(parsed.projectsBaseDir)
      : defaults.projectsBaseDir,
    teamTemplatePath: parsed.teamTemplatePath ?? null,
    dinoNames: parsed.dinoNames ?? undefined,
    timeouts: parseTimeouts(parsed.timeouts),
    models: parseModels(parsed.models),
    notifications: parseNotifications(parsed.notifications),
  };
}

/**
 * Parse the `notifications` key from config.json (notification-egress, Sprint 16 —
 * AC 6/7). Structural clone of `parseModels`/`parseTimeouts`: type guards drop junk
 * field-wise; a malformed `notifications` value (not an object, or an array) is
 * ignored entirely. Absent key → `undefined` → `resolveDrivers` ships the default-on
 * sink; `{ enabled: false }` → the hard off-switch. `loadConfig` never throws on a
 * bad `notifications` value, and NO secret is read or stored.
 */
function parseNotifications(
  raw: unknown
): { enabled?: boolean; sinkPath?: string } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const source = raw as Record<string, unknown>;
  const result: { enabled?: boolean; sinkPath?: string } = {};

  if (typeof source.enabled === "boolean") {
    result.enabled = source.enabled;
  }

  // An empty string is not a usable path → dropped field-wise.
  if (typeof source.sinkPath === "string" && source.sinkPath.length > 0) {
    result.sinkPath = source.sinkPath;
  }

  return result;
}

/** Valid role keys for `models.byRole` (mirrors the `Role` union). */
const VALID_ROLES: readonly Role[] = ["po", "architect", "qa", "engineer", "team"];

/**
 * Parse the `models` key from config.json (adversarial-verifier-review-gate,
 * Part 2 — AC 9). Structured exactly like `parseTimeouts`: type guards drop
 * junk field-wise; a malformed `models` value (not an object, or an array) is
 * ignored entirely. Absent key → `undefined` → `resolveRoleModel` returns
 * `undefined` → `spawnAgent` called with no `--model` → argv byte-identical to
 * today. `loadConfig` never throws on a bad `models` value.
 */
function parseModels(
  raw: unknown
): { default?: string; byRole?: Partial<Record<Role, string>> } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const source = raw as Record<string, unknown>;
  const result: { default?: string; byRole?: Partial<Record<Role, string>> } = {};

  if (typeof source.default === "string" && source.default.length > 0) {
    result.default = source.default;
  }

  if (
    typeof source.byRole === "object" &&
    source.byRole !== null &&
    !Array.isArray(source.byRole)
  ) {
    const byRole: Partial<Record<Role, string>> = {};
    for (const [role, value] of Object.entries(source.byRole)) {
      // Unknown role keys and non-string values are dropped field-wise — a bad
      // config never crashes the orchestrator.
      if (
        (VALID_ROLES as readonly string[]).includes(role) &&
        typeof value === "string" &&
        value.length > 0
      ) {
        byRole[role as Role] = value;
      }
    }
    result.byRole = byRole;
  }

  return result;
}

/**
 * Parse the `timeouts` key from config.json (CB-5, AC 19).
 *
 * Type guards drop non-number values field-wise; a malformed `timeouts` value
 * (not an object) is ignored entirely. Absent key → field absent →
 * byte-identical behavior to before this feature.
 */
function parseTimeouts(
  raw: unknown
): { default?: number; stepOverrides?: Record<string, number> } | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) return undefined;

  const source = raw as Record<string, unknown>;
  const result: { default?: number; stepOverrides?: Record<string, number> } = {};

  if (typeof source.default === "number" && Number.isFinite(source.default)) {
    result.default = source.default;
  }

  if (
    typeof source.stepOverrides === "object" &&
    source.stepOverrides !== null &&
    !Array.isArray(source.stepOverrides)
  ) {
    const overrides: Record<string, number> = {};
    for (const [step, value] of Object.entries(source.stepOverrides)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        overrides[step] = value;
      }
    }
    result.stepOverrides = overrides;
  }

  return result;
}

function resolveHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return path.join(os.homedir(), filepath.slice(2));
  }
  return filepath;
}
