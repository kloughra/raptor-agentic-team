import * as fs from "fs";
import * as path from "path";
import simpleGit from "simple-git";
import { Registry, ProjectEntry } from "./registry";
import {
  SCAFFOLD_DIRS,
  readTemplate,
  generateReadme,
  generateBacklog,
} from "./template";
import {
  parseSprintNumber,
  parseBacklogSections,
} from "./backlog-parser";
import {
  parseBlockers,
  parseEscalations,
  GitLogEntry,
} from "./git-parser";
import {
  runSprintFromStep,
  resumeSprint,
  loadSprintState,
  renderProgressTable,
} from "./orchestrator";
import { loadSprintSummaries } from "./orchestrator/summary";
import { resolveDinoNames } from "./orchestrator/dino";

const PROJECT_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

export interface ToolContext {
  projectsBaseDir: string;
  registry: Registry;
  templatePath: string;
}

export async function bootstrapProject(
  ctx: ToolContext,
  args: { name: string; description: string; location?: string; featureIdeas?: string[] }
): Promise<Record<string, unknown>> {
  // Validate project name
  if (!PROJECT_NAME_REGEX.test(args.name)) {
    return {
      status: "error",
      message: `Invalid project name '${args.name}'. Use lowercase, hyphen-separated format (e.g., 'my-app').`,
    };
  }

  // Check for duplicate
  if (await ctx.registry.projectExists(args.name)) {
    return {
      status: "error",
      message: `Project '${args.name}' already exists. Use list_projects to see all projects.`,
    };
  }

  // Use explicit location if provided, otherwise fall back to config default
  const baseDir = args.location || ctx.projectsBaseDir;

  // Ensure base directory exists
  try {
    fs.mkdirSync(baseDir, { recursive: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      message: `Cannot create base directory '${baseDir}': ${msg}`,
    };
  }

  const projectPath = path.join(baseDir, args.name);

  // Check if directory already exists on disk (even if not in registry)
  if (fs.existsSync(projectPath)) {
    return {
      status: "error",
      message: `Project '${args.name}' already exists. Use list_projects to see all projects.`,
    };
  }

  // Create project directory
  fs.mkdirSync(projectPath, { recursive: true });

  // Git init
  const git = simpleGit(projectPath);
  await git.init();

  // Write TEAM.md
  const teamMdContent = readTemplate(ctx.templatePath);
  fs.writeFileSync(path.join(projectPath, "TEAM.md"), teamMdContent);

  // Write README.md
  fs.writeFileSync(
    path.join(projectPath, "README.md"),
    generateReadme(args.name, args.description)
  );

  // Create scaffold directories with .gitkeep
  const scaffoldedFiles: string[] = ["TEAM.md", "README.md"];

  for (const dir of SCAFFOLD_DIRS) {
    const dirPath = path.join(projectPath, dir);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, ".gitkeep"), "");
    scaffoldedFiles.push(`${dir}/.gitkeep`);
  }

  // Write backlog.md
  const backlogContent = generateBacklog(args.description, args.featureIdeas);
  fs.writeFileSync(path.join(projectPath, "docs", "backlog.md"), backlogContent);
  scaffoldedFiles.push("docs/backlog.md");

  // Git add and commit
  await git.add("-A");
  await git.commit(
    `[BOOTSTRAP] Architect: project scaffold for ${args.name}`
  );

  // Register project
  const now = new Date().toISOString();
  const entry: ProjectEntry = {
    name: args.name,
    slug: args.name,
    description: args.description,
    path: projectPath,
    createdAt: now,
  };
  await ctx.registry.addProject(entry);

  return {
    status: "success",
    project: {
      name: args.name,
      path: projectPath,
      createdAt: now,
    },
    message: `Project '${args.name}' bootstrapped at ${projectPath}. Next step: PO authors the first feature spec.`,
    scaffoldedFiles,
  };
}

export async function listProjects(
  ctx: ToolContext
): Promise<Record<string, unknown>> {
  const projects = await ctx.registry.listProjects();
  return {
    projects: projects.map((p) => ({
      name: p.name,
      description: p.description,
      path: p.path,
      createdAt: p.createdAt,
    })),
    count: projects.length,
  };
}

export async function getProjectStatus(
  ctx: ToolContext,
  args: { name: string }
): Promise<Record<string, unknown>> {
  const project = await ctx.registry.findProject(args.name);

  if (!project) {
    // Check if it exists on disk but isn't tracked
    const potentialPath = path.join(ctx.projectsBaseDir, args.name);
    if (fs.existsSync(potentialPath)) {
      return {
        status: "error",
        message: `Project '${args.name}' exists on disk but is not tracked by Raptor.`,
      };
    }
    return {
      status: "error",
      message: `Project '${args.name}' not found. Use list_projects to see all tracked projects.`,
    };
  }

  // Check if the repo still exists on disk
  if (!fs.existsSync(project.path)) {
    return {
      status: "error",
      message: `Project '${args.name}' is registered but its directory is missing from disk at '${project.path}'.`,
    };
  }

  // Parse backlog
  let sprintNumber = 0;
  let backlogSections = {
    inbox: { count: 0, items: [] as string[] },
    ready: { count: 0, items: [] as string[] },
    sprint: { count: 0, items: [] as string[] },
    done: { count: 0, items: [] as string[] },
  };

  const backlogPath = path.join(project.path, "docs", "backlog.md");
  if (fs.existsSync(backlogPath)) {
    try {
      const backlogContent = fs.readFileSync(backlogPath, "utf-8");
      sprintNumber = parseSprintNumber(backlogContent);
      backlogSections = parseBacklogSections(backlogContent);
    } catch {
      // Best-effort parsing — return zeros if we can't parse
    }
  }

  // Parse git log for blockers and escalations
  let blockers: ReturnType<typeof parseBlockers> = [];
  let escalations: ReturnType<typeof parseEscalations> = [];

  try {
    const git = simpleGit(project.path);
    const log = await git.log();
    const entries: GitLogEntry[] = log.all.map((entry) => ({
      hash: entry.hash,
      date: entry.date,
      message: entry.message,
    }));
    blockers = parseBlockers(entries);
    escalations = parseEscalations(entries);
  } catch {
    // If git log fails, return empty arrays
  }

  // Load orchestrator sprint state if available
  let orchestratorState = null;
  let orchestratorProgress = null;
  if (sprintNumber > 0) {
    const sprintState = loadSprintState(args.name, sprintNumber);
    if (sprintState) {
      orchestratorState = {
        status: sprintState.status,
        currentStep: sprintState.currentStep,
        branchName: sprintState.branchName,
        dod: sprintState.dod,
        steps: sprintState.steps.map((s) => ({
          step: s.step,
          role: s.role,
          name: s.name,
          status: s.status,
          attempts: s.attempts,
          failures: s.failures,
        })),
        checkpoints: sprintState.checkpoints,
      };
      orchestratorProgress = renderProgressTable(sprintState);
    }
  }

  // Count sprint summaries for cross-sprint context info
  let sprintSummariesCount = 0;
  try {
    const sprintsDir = path.join(project.path, "docs", "sprints");
    if (fs.existsSync(sprintsDir)) {
      sprintSummariesCount = fs.readdirSync(sprintsDir)
        .filter((f: string) => /^sprint-\d+-summary\.md$/.test(f)).length;
    }
  } catch {
    // Best effort
  }

  // Determine if the sprint PR has been merged
  const merged = orchestratorState?.steps.some(
    (s: { name: string; status: string }) => s.name === "Merge PR" && s.status === "complete"
  ) ?? false;

  return {
    status: "success",
    project: args.name,
    sprint: {
      current: sprintNumber,
      merged,
      items: backlogSections.sprint.items.map((item) => {
        const parts = item.split(":");
        const slug = parts[0].trim();
        const desc = parts.slice(1).join(":").trim();
        return { slug, description: desc, done: item.includes("[x]") };
      }),
    },
    backlog: backlogSections,
    blockers,
    escalations,
    orchestrator: orchestratorState,
    orchestratorProgress,
    sprintSummariesCount,
    dinoNames: resolveDinoNames(),
  };
}

export async function runSprint(
  ctx: ToolContext,
  args: { name: string; sprint: number }
): Promise<Record<string, unknown>> {
  const project = await ctx.registry.findProject(args.name);
  if (!project) {
    return {
      status: "error",
      message: `Project '${args.name}' not found. Use bootstrap_project to create it first.`,
    };
  }

  if (!fs.existsSync(project.path)) {
    return {
      status: "error",
      message: `Project directory missing at '${project.path}'.`,
    };
  }

  // Verify backlog has items for this sprint
  const backlogPath = path.join(project.path, "docs", "backlog.md");
  if (fs.existsSync(backlogPath)) {
    const content = fs.readFileSync(backlogPath, "utf-8");
    const sprintSection = content.match(
      new RegExp(`## Sprint ${args.sprint}[^]*?(?=\\n## |$)`)
    );
    if (!sprintSection || !sprintSection[0].includes("- [")) {
      return {
        status: "error",
        message: `No backlog items found for sprint ${args.sprint}. Add items to the backlog before running a sprint.`,
      };
    }
  } else {
    return {
      status: "error",
      message: "No backlog.md found in the project.",
    };
  }

  const result = await runSprintFromStep(
    project.path,
    args.name,
    args.sprint,
    1
  );

  return {
    status: result.status,
    progress: result.progress,
    checkpoint: result.checkpoint
      ? {
          type: result.checkpoint.type,
          title: result.checkpoint.title,
          context: result.checkpoint.context,
          options: result.checkpoint.options,
        }
      : undefined,
    message: result.message,
  };
}

export async function resumeSprintTool(
  ctx: ToolContext,
  args: {
    name: string;
    sprint: number;
    action: "approve" | "request-changes";
    feedback?: string;
  }
): Promise<Record<string, unknown>> {
  const project = await ctx.registry.findProject(args.name);
  if (!project) {
    return {
      status: "error",
      message: `Project '${args.name}' not found.`,
    };
  }

  if (!fs.existsSync(project.path)) {
    return {
      status: "error",
      message: `Project directory missing at '${project.path}'.`,
    };
  }

  const result = await resumeSprint(
    project.path,
    args.name,
    args.sprint,
    args.action,
    args.feedback
  );

  return {
    status: result.status,
    progress: result.progress,
    checkpoint: result.checkpoint
      ? {
          type: result.checkpoint.type,
          title: result.checkpoint.title,
          context: result.checkpoint.context,
          options: result.checkpoint.options,
        }
      : undefined,
    message: result.message,
  };
}
