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

const RAPTOR_HOME = path.join(os.homedir(), ".raptor");
const CONFIG_PATH = path.join(RAPTOR_HOME, "config.json");
const REGISTRY_PATH = path.join(RAPTOR_HOME, "projects.json");

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
      const result = await bootstrapProject(ctx, args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
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
      const result = await adoptProject(ctx, args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // Register list_projects tool
  server.tool(
    "list_projects",
    "List all projects bootstrapped by Raptor",
    {},
    async () => {
      const result = await listProjects(ctx);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
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
      const result = await getProjectStatus(ctx, args);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
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

      return { content };
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
    },
    async (args) => {
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

      return { content };
    }
  );

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Raptor failed to start:", err.message);
  process.exit(1);
});
