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
  };
}

function resolveHome(filepath: string): string {
  if (filepath.startsWith("~/")) {
    return path.join(os.homedir(), filepath.slice(2));
  }
  return filepath;
}
