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
  listProjects,
  getProjectStatus,
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
    "Create a new project repository with the full agentic team scaffold",
    {
      name: z
        .string()
        .describe(
          "Project name (lowercase, hyphen-separated, no special characters)"
        ),
      description: z
        .string()
        .describe("Brief description of what this project is"),
      featureIdeas: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of initial feature ideas to add to the backlog Inbox"
        ),
    },
    async (args) => {
      const result = await bootstrapProject(ctx, args);
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

  // Start server with stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Raptor failed to start:", err.message);
  process.exit(1);
});
