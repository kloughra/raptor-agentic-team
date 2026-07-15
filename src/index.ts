#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as path from "path";
import * as os from "os";
import { z } from "zod";
import { loadConfig } from "./config";
import { Registry } from "./registry";
import {
  getTemplatePath,
  validateTemplate,
} from "./template";
import {
  bootstrapProject,
  adoptProject,
  listProjects,
  getProjectStatus,
  runSprint,
  resumeSprintTool,
  ToolContext,
} from "./tools";
import { surfaceOutcome, buildThrownErrorResult } from "./error-surfacing";

const RAPTOR_HOME = path.join(os.homedir(), ".raptor");
const CONFIG_PATH = path.join(RAPTOR_HOME, "config.json");
const REGISTRY_PATH = path.join(RAPTOR_HOME, "projects.json");

/**
 * Register all six Raptor tools on the given MCP server.
 *
 * Every handler routes its outcome through the single surfacing seam
 * (`surfaceOutcome` on returns, `buildThrownErrorResult` on throws) so no tool
 * can swallow a failure into a success at the MCP boundary (D1/D2).
 *
 * Exported so tests can drive the REAL registered handlers — see
 * `tests/integration/surface-tool-errors-seam.integration.test.ts`, which
 * captures each registered callback and asserts it surfaces failures. This is
 * the drift guard the PO required (R1 / AC #10): an unwired handler fails the
 * suite instead of silently shipping a swallowed failure.
 */
export function registerTools(server: McpServer, ctx: ToolContext): void {
  // Register bootstrap_project tool
  server.tool(
    "bootstrap_project",
    "Create a new project repository with the full agentic team scaffold. Ask the user for: project location, app name, and any initial feature ideas.",
    {
      name: z
        .string()
        .describe(
          "Project name (lowercase, hyphen-separated, no special characters, e.g. 'my-app')"
        ),
      description: z
        .string()
        .describe("Brief description of what this project is"),
      location: z
        .string()
        .optional()
        .describe(
          "Directory where the project folder will be created (e.g. '/Users/me/workspace'). Defaults to ~/workspace if not specified."
        ),
      featureIdeas: z
        .array(z.string())
        .optional()
        .describe(
          "List of initial feature ideas to seed the backlog Inbox (e.g. ['user-login', 'search', 'notifications'])"
        ),
    },
    async (args) => {
      try {
        const result = await bootstrapProject(ctx, args);
        const content = [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ];
        return surfaceOutcome(result, content);
      } catch (err) {
        return buildThrownErrorResult("bootstrap_project", err);
      }
    }
  );

  // Register adopt_project tool
  server.tool(
    "adopt_project",
    "Adopt an existing repository into Raptor. Scaffolds only missing files (TEAM.md, docs dirs, backlog), discovers project context from existing files, and registers the project so run_sprint works.",
    {
      path: z
        .string()
        .describe(
          "Absolute path to the existing git repository (e.g. '/Users/me/workspace/my-app')"
        ),
      name: z
        .string()
        .describe(
          "Project name for Raptor registration (lowercase, hyphen-separated, e.g. 'my-app')"
        ),
      description: z
        .string()
        .describe("Brief description of what this project is"),
      featureIdeas: z
        .array(z.string())
        .optional()
        .describe(
          "List of initial feature ideas to seed the backlog Inbox"
        ),
    },
    async (args) => {
      try {
        const result = await adoptProject(ctx, args);
        const content = [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ];
        return surfaceOutcome(result, content);
      } catch (err) {
        return buildThrownErrorResult("adopt_project", err);
      }
    }
  );

  // Register list_projects tool
  server.tool(
    "list_projects",
    "List all projects bootstrapped by Raptor",
    {},
    async () => {
      try {
        const result = await listProjects(ctx);
        const content = [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ];
        return surfaceOutcome(result, content);
      } catch (err) {
        return buildThrownErrorResult("list_projects", err);
      }
    }
  );

  // Register get_project_status tool
  server.tool(
    "get_project_status",
    "Get the current status of a project including sprint, backlog, blockers, and escalations",
    {
      name: z
        .string()
        .describe("Project name as registered in Raptor"),
    },
    async (args) => {
      try {
        const result = await getProjectStatus(ctx, args);
        const content = [
          { type: "text" as const, text: JSON.stringify(result, null, 2) },
        ];
        return surfaceOutcome(result, content);
      } catch (err) {
        return buildThrownErrorResult("get_project_status", err);
      }
    }
  );

  // Register run_sprint tool
  server.tool(
    "run_sprint",
    "Run a sprint for a project — orchestrates agents through the full BDD/TDD workflow with user checkpoints",
    {
      name: z
        .string()
        .describe("Project name as registered in Raptor"),
      sprint: z
        .number()
        .int()
        .positive()
        .describe("Sprint number to run"),
    },
    async (args) => {
      try {
        const result = await runSprint(ctx, args);
        const content: { type: "text"; text: string }[] = [];

        // Always include progress table
        if (result.progress) {
          content.push({ type: "text" as const, text: result.progress as string });
        }

        // Include checkpoint prompt if paused
        if (result.checkpoint) {
          const cp = result.checkpoint as { title: string; context: string };
          content.push({
            type: "text" as const,
            text: `\n## Checkpoint: ${cp.title}\n\n${cp.context}`,
          });
        }

        // Include message if present
        if (result.message) {
          content.push({ type: "text" as const, text: result.message as string });
        }

        return surfaceOutcome(result, content);
      } catch (err) {
        return buildThrownErrorResult("run_sprint", err);
      }
    }
  );

  // Register resume_sprint tool
  server.tool(
    "resume_sprint",
    "Resume a sprint after a user checkpoint — provide your decision (approve/request-changes) and optional feedback",
    {
      name: z
        .string()
        .describe("Project name"),
      sprint: z
        .number()
        .int()
        .positive()
        .describe("Sprint number"),
      action: z
        .enum(["approve", "request-changes"])
        .describe("User's decision at the checkpoint"),
      feedback: z
        .string()
        .optional()
        .describe("Free-text feedback from the user"),
      feature: z
        .string()
        .optional()
        .describe(
          "Optional feature slug to target when resuming a multi-feature sprint that has more than one escalated feature (e.g. 'live-claude-smoke-test'). Omit when exactly one feature is escalated — it is targeted implicitly."
        ),
    },
    async (args) => {
      try {
        const result = await resumeSprintTool(ctx, args);
        const content: { type: "text"; text: string }[] = [];

        if (result.progress) {
          content.push({ type: "text" as const, text: result.progress as string });
        }

        if (result.checkpoint) {
          const cp = result.checkpoint as { title: string; context: string };
          content.push({
            type: "text" as const,
            text: `\n## Checkpoint: ${cp.title}\n\n${cp.context}`,
          });
        }

        if (result.message) {
          content.push({ type: "text" as const, text: result.message as string });
        }

        return surfaceOutcome(result, content);
      } catch (err) {
        return buildThrownErrorResult("resume_sprint", err);
      }
    }
  );
}

async function main() {
  // Load config
  const config = loadConfig(CONFIG_PATH);

  // Resolve and validate template
  const templatePath = getTemplatePath(config.teamTemplatePath);
  validateTemplate(templatePath);

  // Set up registry
  const registry = new Registry(REGISTRY_PATH);

  // Build tool context
  const ctx: ToolContext = {
    projectsBaseDir: config.projectsBaseDir,
    registry,
    templatePath,
  };

  // Create MCP server
  const server = new McpServer({
    name: "raptor",
    version: "0.1.0",
  });

  // Register all tools on the surfacing seam
  registerTools(server, ctx);

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only boot the stdio server when run as the entry point (production `bin` /
// `tsx` dev loop). Importing this module in tests must NOT start a transport —
// it exposes `registerTools` for the real-seam conformance test.
if (require.main === module) {
  main().catch((err) => {
    console.error("Raptor failed to start:", err.message);
    process.exit(1);
  });
}
