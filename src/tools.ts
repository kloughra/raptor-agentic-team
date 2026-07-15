import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import simpleGit from "simple-git";
import { Registry, ProjectEntry } from "./registry";
import { RaptorConfig } from "./config";
import {
  SCAFFOLD_DIRS,
  readTemplate,
  generateReadme,
  generateBacklog,
} from "./template";
import {
  parseSprintNumber,
  parseBacklogSections,
  resolveBacklogPath,
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
  saveSprintState,
  deleteSprintState,
  renderProgressTable,
  emitNotification,
} from "./orchestrator";
import { resolveDrivers } from "./orchestrator/notification-driver";
import { SprintState } from "./orchestrator/state";
import { loadSprintSummaries } from "./orchestrator/summary";
import { resolveDinoNames } from "./orchestrator/dino";
import { discoverProjectContext, generateContextDocument } from "./orchestrator/context-discovery";

const PROJECT_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

/**
 * Search common locations for an existing backlog file (case-insensitive).
 * Returns the absolute path if found, null otherwise.
 */
function findExistingBacklog(projectPath: string): string | null {
  const candidateDirs = [
    path.join(projectPath, "docs"),
    projectPath,
  ];
  const candidateNames = ["backlog.md", "BACKLOG.md", "BACKLOG.MD", "Backlog.md"];

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (candidateNames.includes(file) || file.toLowerCase() === "backlog.md") {
          return path.join(dir, file);
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }
  return null;
}

/**
 * Reformat an existing backlog's content into Raptor's canonical format.
 * Preserves all items — categorizes them into Raptor sections.
 *
 * Raptor format:
 *   # Backlog
 *   ## Sprint N — Planned   (active sprint items)
 *   ## Ready (prioritized, next sprint)
 *   ## Inbox (unprioritized)
 *   ## Done
 */
function reformatBacklogToRaptor(
  existingContent: string,
  description: string,
  featureIdeas?: string[]
): string {
  const lines = existingContent.split("\n");

  // Collect all items grouped by detected section
  const sprintItems: string[] = [];
  const readyItems: string[] = [];
  const inboxItems: string[] = [];
  const doneItems: string[] = [];
  const unmatchedContent: string[] = [];

  let currentSection: "sprint" | "ready" | "inbox" | "done" | "unknown" | null = null;
  let detectedSprintNumber = 0;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip the top-level title
    if (/^#\s+(backlog|todo|tasks|roadmap)/i.test(trimmed)) continue;

    // Detect section headers (flexible matching)
    if (/^#{1,3}\s+sprint\s+(\d+)/i.test(trimmed)) {
      currentSection = "sprint";
      const m = trimmed.match(/sprint\s+(\d+)/i);
      if (m) detectedSprintNumber = Math.max(detectedSprintNumber, parseInt(m[1], 10));
      continue;
    }
    if (/^#{1,3}\s*(ready|up\s*next|prioritized|next\s*sprint|planned)/i.test(trimmed)) {
      currentSection = "ready";
      continue;
    }
    if (/^#{1,3}\s*(inbox|unprioritized|ideas|icebox|someday|backlog items|future)/i.test(trimmed)) {
      currentSection = "inbox";
      continue;
    }
    if (/^#{1,3}\s*(done|completed|finished|shipped|released|closed)/i.test(trimmed)) {
      currentSection = "done";
      continue;
    }
    if (/^#{1,3}\s*(in\s*progress|current|active|wip|doing)/i.test(trimmed)) {
      currentSection = "sprint";
      continue;
    }
    // Any other heading — treat content under it as unknown/inbox
    if (/^#{1,3}\s+/.test(trimmed)) {
      currentSection = "unknown";
      continue;
    }

    // Parse list items
    // Match bullet lists (- or *), numbered lists (1.), and checkbox lists
    const itemMatch = trimmed.match(/^(?:[-*]|\d+\.)\s+(?:\[([x ])\]\s+)?(.+)/i);
    if (itemMatch) {
      const checked = itemMatch[1]?.toLowerCase() === "x";
      const itemText = itemMatch[2].trim();
      if (itemText.length === 0) continue;

      if (checked) {
        doneItems.push(`- [x] ${itemText}`);
      } else if (currentSection === "sprint") {
        sprintItems.push(`- [ ] ${itemText}`);
      } else if (currentSection === "ready") {
        readyItems.push(`- ${itemText}`);
      } else if (currentSection === "done") {
        doneItems.push(`- [x] ${itemText}`);
      } else if (currentSection === "inbox" || currentSection === "unknown") {
        inboxItems.push(`- ${itemText}`);
      } else {
        // No section context — treat as inbox
        inboxItems.push(`- ${itemText}`);
      }
      continue;
    }

    // Non-list, non-heading content — preserve as-is if non-empty
    if (trimmed.length > 0 && currentSection !== null) {
      unmatchedContent.push(trimmed);
    }
  }

  // Add feature ideas to inbox if provided
  const filtered = (featureIdeas ?? []).filter((idea) => idea.trim().length > 0);
  for (const idea of filtered) {
    inboxItems.push(`- ${idea.trim()}: (no description yet) — source: project adoption`);
  }

  // Build Raptor-format backlog
  const sections: string[] = [];
  sections.push("# Backlog\n");

  if (sprintItems.length > 0) {
    const sprintNum = detectedSprintNumber > 0 ? detectedSprintNumber : 1;
    sections.push(`## Sprint ${sprintNum} — Planned`);
    sections.push(sprintItems.join("\n"));
    sections.push("");
  }

  sections.push("## Ready (prioritized, next sprint)");
  if (readyItems.length > 0) {
    sections.push(readyItems.join("\n"));
  }
  sections.push("");

  sections.push("## Inbox (unprioritized)");
  if (inboxItems.length > 0) {
    sections.push(inboxItems.join("\n"));
  }
  if (unmatchedContent.length > 0) {
    sections.push("");
    sections.push("<!-- Preserved from original backlog -->");
    sections.push(unmatchedContent.join("\n"));
  }
  sections.push("");

  sections.push("## Done");
  if (doneItems.length > 0) {
    sections.push(doneItems.join("\n"));
  }
  sections.push("");

  return sections.join("\n");
}

export interface ToolContext {
  projectsBaseDir: string;
  registry: Registry;
  templatePath: string;
  /**
   * notification-egress (Sprint 16): the loaded Raptor config, used to resolve
   * notification drivers at the tool boundary. Optional & additive — when absent
   * (e.g. tests that build a bare context) no notification is dispatched, so the
   * behavior is byte-for-byte pre-feature.
   */
  notifications?: {
    config: RaptorConfig;
  };
}

/**
 * notification-egress (Sprint 16) — the production emission seam.
 *
 * After a `run_sprint`/`resume_sprint` invocation returns, reload the
 * freshly-persisted `SprintState` from disk and dispatch a single, best-effort
 * notification derived EXCLUSIVELY from that persisted state (never agent stdout —
 * AC #2). Fully swallow-all wrapped: a notification failure can never break the
 * tool call (AC #9). No-op when notifications are unconfigured on the context.
 */
async function dispatchNotification(
  ctx: ToolContext,
  projectSlug: string,
  sprint: number
): Promise<void> {
  try {
    if (!ctx.notifications) return;
    const state = loadSprintState(projectSlug, sprint);
    if (!state) return;

    const sinkPath = resolveSinkPath(ctx.notifications.config, projectSlug);
    const drivers = resolveDrivers(ctx.notifications.config, sinkPath);

    await emitNotification(state, drivers, {
      projectSlug,
      occurredAt: new Date().toISOString(),
      save: (s: SprintState) => saveSprintState(projectSlug, sprint, s),
    });
  } catch {
    // Best-effort: emission never disturbs the tool result.
  }
}

/** Resolve the notification sink path — config override (with `~` and `{slug}`) or default. */
function resolveSinkPath(config: RaptorConfig, projectSlug: string): string {
  const override = config.notifications?.sinkPath;
  if (override && override.length > 0) {
    const expanded = override.startsWith("~/")
      ? path.join(os.homedir(), override.slice(2))
      : override;
    return expanded.replace("{slug}", projectSlug);
  }
  return path.join(os.homedir(), ".raptor", projectSlug, "notifications.jsonl");
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

export async function adoptProject(
  ctx: ToolContext,
  args: { path: string; name: string; description: string; featureIdeas?: string[] }
): Promise<Record<string, unknown>> {
  // Validate project name
  if (!PROJECT_NAME_REGEX.test(args.name)) {
    return {
      status: "error",
      message: `Invalid project name '${args.name}'. Use lowercase, hyphen-separated format (e.g., 'my-app').`,
    };
  }

  // Check for duplicate name — allow upsert if same path
  let isReAdoption = false;
  const existingByName = await ctx.registry.findProject(args.name);
  if (existingByName) {
    if (existingByName.path === args.path) {
      // Same name, same path — this is a re-adoption (upsert)
      isReAdoption = true;
    } else {
      return {
        status: "error",
        message: `Project '${args.name}' is already registered at a different path: '${existingByName.path}'.`,
      };
    }
  }

  // Validate path exists and is a directory
  if (!fs.existsSync(args.path)) {
    return {
      status: "error",
      message: `Path '${args.path}' does not exist.`,
    };
  }

  if (!fs.statSync(args.path).isDirectory()) {
    return {
      status: "error",
      message: `Path '${args.path}' is not a directory.`,
    };
  }

  // Check path is a git repo
  const gitDir = path.join(args.path, ".git");
  if (!fs.existsSync(gitDir)) {
    return {
      status: "error",
      message: `Path must be an initialized git repository. Run 'git init' in '${args.path}' first.`,
    };
  }

  // Check path not already registered under a different name
  if (!isReAdoption) {
    const projects = await ctx.registry.listProjects();
    const existingByPath = projects.find((p) => p.path === args.path);
    if (existingByPath) {
      return {
        status: "error",
        message: `This repo is already tracked as '${existingByPath.name}'.`,
      };
    }
  }

  const projectPath = args.path;
  const scaffoldedFiles: string[] = [];
  const skippedFiles: string[] = [];

  // Scaffold TEAM.md — only if missing
  const teamMdPath = path.join(projectPath, "TEAM.md");
  if (!fs.existsSync(teamMdPath)) {
    const teamMdContent = readTemplate(ctx.templatePath);
    fs.writeFileSync(teamMdPath, teamMdContent);
    scaffoldedFiles.push("TEAM.md");
  } else {
    skippedFiles.push("TEAM.md (already exists)");
  }

  // Scaffold directories — additive only
  for (const dir of SCAFFOLD_DIRS) {
    const dirPath = path.join(projectPath, dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      fs.writeFileSync(path.join(dirPath, ".gitkeep"), "");
      scaffoldedFiles.push(`${dir}/.gitkeep`);
    } else {
      skippedFiles.push(`${dir}/ (already exists)`);
    }
  }

  // Backlog handling: find existing backlog (case-insensitive), reformat if found, scaffold if not
  const canonicalBacklogPath = path.join(projectPath, "docs", "backlog.md");
  const existingBacklogPath = findExistingBacklog(projectPath);

  if (existingBacklogPath) {
    // Found an existing backlog — always reformat into Raptor canonical format
    try {
      const existingContent = fs.readFileSync(existingBacklogPath, "utf-8");
      const reformatted = reformatBacklogToRaptor(existingContent, args.description, args.featureIdeas);

      // Ensure docs dir exists
      fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
      fs.writeFileSync(canonicalBacklogPath, reformatted);

      // If the original was in a different location or had a different casing, note it
      const existingRelative = path.relative(projectPath, existingBacklogPath);
      const canonicalRelative = "docs/backlog.md";

      if (existingRelative.toLowerCase() !== canonicalRelative.toLowerCase()) {
        // Different location (e.g., root BACKLOG.md → docs/backlog.md)
        scaffoldedFiles.push("docs/backlog.md");
        skippedFiles.push(`${existingRelative} (reformatted into docs/backlog.md)`);
      } else if (existingRelative !== canonicalRelative) {
        // Same location but different casing (e.g., docs/BACKLOG.md → docs/backlog.md)
        scaffoldedFiles.push("docs/backlog.md (reformatted from " + existingRelative + ")");
      } else {
        // Already at canonical path — reformatted in place
        scaffoldedFiles.push("docs/backlog.md (reformatted from existing)");
      }
    } catch {
      // Fall back to generating a new backlog if reformat fails
      fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
      const backlogContent = generateBacklog(args.description, args.featureIdeas);
      fs.writeFileSync(canonicalBacklogPath, backlogContent);
      scaffoldedFiles.push("docs/backlog.md");
    }
  } else {
    // No existing backlog found anywhere — scaffold a fresh one
    fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
    const backlogContent = generateBacklog(args.description, args.featureIdeas);
    fs.writeFileSync(canonicalBacklogPath, backlogContent);
    scaffoldedFiles.push("docs/backlog.md");
  }

  // Context discovery — generate or regenerate project-context.md
  // Always regenerate on re-adoption to pick up codebase changes
  let contextDiscovered = false;
  const contextPath = path.join(projectPath, "docs", "project-context.md");
  if (!fs.existsSync(contextPath) || isReAdoption) {
    try {
      fs.mkdirSync(path.join(projectPath, "docs"), { recursive: true });
      const context = discoverProjectContext(projectPath);
      const contextDoc = generateContextDocument(context, args.name);
      fs.writeFileSync(contextPath, contextDoc);
      scaffoldedFiles.push(isReAdoption ? "docs/project-context.md (regenerated)" : "docs/project-context.md");
      contextDiscovered = true;
    } catch {
      // Context discovery is best-effort
    }
  } else {
    skippedFiles.push("docs/project-context.md (already exists)");
  }

  // Git commit for scaffolded files (if any)
  if (scaffoldedFiles.length > 0) {
    try {
      const git = simpleGit(projectPath);
      // Filter out annotation suffixes for git add paths
      const filePaths = scaffoldedFiles.map((f) => {
        const clean = f.replace(/\s*\(.*\)$/, "");
        return path.join(projectPath, clean);
      });
      await git.add(filePaths);
      const verb = isReAdoption ? "re-adopted" : "adopted";
      await git.commit(`[BOOTSTRAP] Architect: ${verb} existing project ${args.name}`);
    } catch {
      // Non-critical — files are written even if commit fails
    }
  }

  // Register or update project
  const now = new Date().toISOString();
  if (isReAdoption) {
    // Update existing entry
    await ctx.registry.updateProject(args.name, {
      description: args.description,
    });
  } else {
    const entry: ProjectEntry = {
      name: args.name,
      slug: args.name,
      description: args.description,
      path: projectPath,
      createdAt: now,
    };
    await ctx.registry.addProject(entry);
  }

  const verb = isReAdoption ? "re-adopted" : "adopted";
  return {
    status: "success",
    project: {
      name: args.name,
      path: projectPath,
      createdAt: isReAdoption ? existingByName!.createdAt : now,
    },
    scaffoldedFiles,
    skippedFiles,
    contextDiscovered,
    isReAdoption,
    message: `Project '${args.name}' ${verb} from ${projectPath}. ${scaffoldedFiles.length} files scaffolded, ${skippedFiles.length} skipped. Next step: populate the backlog and run a sprint.`,
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

  const backlogPath = resolveBacklogPath(project.path);
  if (backlogPath) {
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
  const backlogPath = resolveBacklogPath(project.path);
  if (backlogPath) {
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
      message: "No backlog.md found in the project. Looked for backlog.md (any casing) in docs/ and project root.",
    };
  }

  const result = await runSprintFromStep(
    project.path,
    args.name,
    args.sprint,
    1
  );

  // notification-egress (Sprint 16): emit a state-derived event at the boundary.
  await dispatchNotification(ctx, args.name, args.sprint);

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
    feature?: string;
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
    args.feedback,
    args.feature
  );

  // notification-egress (Sprint 16): emit a state-derived event at the boundary.
  await dispatchNotification(ctx, args.name, args.sprint);

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

/**
 * reset_sprint (Sprint 16) — the first-class complement to resume_sprint: clear
 * the persisted per-sprint state so a subsequent `run_sprint {slug} {N}` starts
 * that sprint over from step 1 with a clean slate. Frees a sprint wedged in any
 * status resume_sprint refuses — most importantly the un-resumable `in-progress`
 * limbo. Never throws to the transport; every failure returns `{status:"error"}`.
 * Touches ONLY ~/.raptor/{slug}/sprint-{N}.json — no git, artifacts, or registry.
 */
export async function resetSprintTool(
  ctx: ToolContext,
  args: { name: string; sprint: number; confirm?: boolean }
): Promise<Record<string, unknown>> {
  const project = await ctx.registry.findProject(args.name);
  if (!project) {
    return { status: "error", message: `Project '${args.name}' not found.` };
  }

  if (!fs.existsSync(project.path)) {
    return {
      status: "error",
      message: `Project directory missing at '${project.path}'.`,
    };
  }

  const nextAction = `run_sprint ${args.name} ${args.sprint}`;

  // No state on disk → informative no-op success (AC 6); idempotent (NFR-2).
  const state = loadSprintState(args.name, args.sprint);
  if (!state) {
    return {
      status: "success",
      project: args.name,
      sprint: args.sprint,
      priorStatus: "none",
      message: `No sprint state found for sprint ${args.sprint} — nothing to reset.`,
      nextAction,
    };
  }

  // Guard a completed (shipped) sprint unless explicitly forced (AC 7). Every
  // other status — escalated / failed / in-progress / paused — resets freely.
  if (state.status === "complete" && args.confirm !== true) {
    return {
      status: "error",
      project: args.name,
      sprint: args.sprint,
      priorStatus: "complete",
      message:
        `Sprint ${args.sprint} is 'complete' (shipped). Re-run reset_sprint with ` +
        `confirm=true to force-discard its orchestration state. Committed ` +
        `artifacts, PR, and summary are unaffected.`,
    };
  }

  // Clear the state file (AC 4, 5). A genuine FS failure surfaces as an error,
  // never a swallowed success (AC 10, NFR-3).
  try {
    deleteSprintState(args.name, args.sprint);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      project: args.name,
      sprint: args.sprint,
      priorStatus: state.status,
      message: `Failed to clear sprint state for sprint ${args.sprint}: ${reason}`,
    };
  }

  const totalSteps = state.steps.length;
  const completedSteps = state.steps.filter((s) => s.status === "complete").length;

  return {
    status: "success",
    project: args.name,
    sprint: args.sprint,
    priorStatus: state.status,
    summary: `${completedSteps}/${totalSteps} steps complete, status '${state.status}'`,
    message: `Cleared sprint ${args.sprint} state (was '${state.status}').`,
    nextAction,
  };
}
