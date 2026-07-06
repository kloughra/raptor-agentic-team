import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface RaptorConfig {
  projectsBaseDir: string;
  teamTemplatePath: string | null;
  dinoNames?: Partial<Record<string, { species?: string; nickname?: string; emoji?: string }>>;
  timeouts?: {
    default?: number;
    stepOverrides?: Record<string, number>;
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
  };
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
