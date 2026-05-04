import * as fs from "fs";
import * as path from "path";

/**
 * Resolve the bundled `template/TEAM.md` path under both runtime layouts:
 *
 *   - Production (compiled): this file lives at `dist/src/template.js`, so the
 *     bundled template is two levels up at `<repo>/template/TEAM.md`.
 *   - Development (tsx, no dist/): this file is loaded as `src/template.ts`,
 *     so the template is one level up at `<repo>/template/TEAM.md`.
 *
 * Both candidates are tried in production-first order so the prod path takes
 * precedence when both layouts exist on disk.
 */
function resolveBundledTemplatePath(): string {
  const distLayout = path.join(__dirname, "..", "..", "template", "TEAM.md");
  if (fs.existsSync(distLayout)) {
    return distLayout;
  }
  const srcLayout = path.join(__dirname, "..", "template", "TEAM.md");
  if (fs.existsSync(srcLayout)) {
    return srcLayout;
  }
  // Fall back to the dist-layout path so error messages remain stable for
  // production deployments where neither file exists (corrupt install).
  return distLayout;
}

const BUNDLED_TEMPLATE_PATH = resolveBundledTemplatePath();

export const SCAFFOLD_DIRS = [
  "docs/specs",
  "docs/architecture",
  "docs/adr",
  "docs/demos",
  "docs/sprints",
  "tests/bdd",
  "tests/integration",
  "tests/performance",
  "tests/e2e",
  "tests/e2e/screenshots",
  "src",
];

export function getTemplatePath(overridePath: string | null): string {
  if (overridePath) {
    return overridePath;
  }
  return BUNDLED_TEMPLATE_PATH;
}

export function validateTemplate(templatePath: string): void {
  if (!fs.existsSync(templatePath)) {
    throw new Error(
      `TEAM.md template not found at '${templatePath}'. Raptor cannot start without its template.`
    );
  }
  const content = fs.readFileSync(templatePath, "utf-8");
  if (content.trim().length === 0) {
    throw new Error(
      `TEAM.md template at '${templatePath}' is empty. Raptor cannot start with a corrupt template.`
    );
  }
}

export function readTemplate(templatePath: string): string {
  return fs.readFileSync(templatePath, "utf-8");
}

export function generateReadme(projectName: string, description: string): string {
  return `# ${projectName}\n\n${description}\n`;
}

export function generateBacklog(
  description: string,
  featureIdeas?: string[]
): string {
  const filtered = (featureIdeas ?? []).filter((idea) => idea.trim().length > 0);

  let content = `# Backlog\n\n## Ready (prioritized, next sprint)\n\n## Inbox (unprioritized)\n`;

  if (filtered.length > 0) {
    for (const idea of filtered) {
      content += `- ${idea.trim()}: (no description yet) — source: project bootstrap\n`;
    }
  }

  content += `\n## Done\n`;

  return content;
}
