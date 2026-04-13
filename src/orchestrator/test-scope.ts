import * as fs from "fs";
import * as path from "path";

export type TestFramework = "jest" | "pytest" | "cargo" | "unknown";

export interface TestScopeConfig {
  framework?: TestFramework;
  testCommand?: string;      // Custom command with {slug} placeholder
  scopedPattern?: string;    // Custom scoped pattern with {slug} placeholder
}

/**
 * Detect the test framework used in a project by checking for package manifests.
 */
export function detectTestFramework(projectPath: string): TestFramework {
  if (fs.existsSync(path.join(projectPath, "package.json"))) {
    return "jest";
  }
  if (
    fs.existsSync(path.join(projectPath, "pyproject.toml")) ||
    fs.existsSync(path.join(projectPath, "setup.py"))
  ) {
    return "pytest";
  }
  if (fs.existsSync(path.join(projectPath, "Cargo.toml"))) {
    return "cargo";
  }
  return "unknown";
}

/**
 * Escape a feature slug for use in test path patterns.
 * Standard Raptor slugs (^[a-z][a-z0-9-]*$) don't need escaping,
 * but this is defensive for edge cases.
 */
export function escapeForTestPattern(slug: string): string {
  return slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a scoped test command that runs only tests matching the feature slug.
 * Returns null if the framework is unknown and no custom command is configured.
 */
export function buildScopedTestCommand(
  framework: TestFramework,
  featureSlug: string,
  config?: TestScopeConfig
): string | null {
  const escapedSlug = escapeForTestPattern(featureSlug);

  if (config?.testCommand) {
    return config.testCommand.replace(/\{slug\}/g, escapedSlug);
  }

  switch (framework) {
    case "jest":
      return `npx jest --testPathPattern="${escapedSlug}"`;
    case "pytest":
      return `pytest -k "${escapedSlug}"`;
    case "cargo":
      return `cargo test ${escapedSlug}`;
    case "unknown":
      return null;
  }
}

/**
 * Build a full (unscoped) test command.
 * Returns null if the framework is unknown and no custom command is configured.
 */
export function buildFullTestCommand(
  framework: TestFramework,
  config?: TestScopeConfig
): string | null {
  if (config?.testCommand) {
    return config.testCommand.replace(/\{slug\}/g, "").replace(/\s+/g, " ").trim();
  }

  switch (framework) {
    case "jest":
      return "npx jest";
    case "pytest":
      return "pytest";
    case "cargo":
      return "cargo test";
    case "unknown":
      return null;
  }
}

/**
 * Build the test scope section for an agent's task description.
 * Returns the section string to append, or empty string if no scoping applies.
 */
export function buildTestScopeSection(
  stepName: string,
  featureSlug: string,
  framework: TestFramework,
  isMultiFeature: boolean,
  config?: TestScopeConfig
): string {
  const sections: string[] = [];

  if (stepName === "Implement (TDD)") {
    const scopedCmd = buildScopedTestCommand(framework, featureSlug, config);
    if (scopedCmd) {
      sections.push("\n## Test Scope");
      sections.push(`Run ONLY tests matching your feature: \`${scopedCmd}\``);
      sections.push("Do NOT run the full test suite — other features may be worked on in parallel.");
    }

    if (isMultiFeature) {
      sections.push("\n## Shared File Warning");
      sections.push("Do NOT modify shared config files (jest.config.js, pyproject.toml, tsconfig.json, Cargo.toml, etc.).");
      sections.push("These are shared across features and concurrent modification will cause conflicts.");
      sections.push("If a config change is needed, raise a [BLOCKER].");
    }
  }

  if (stepName === "Run test suite") {
    const fullCmd = buildFullTestCommand(framework, config);
    if (fullCmd) {
      sections.push(`\nRun the FULL test suite: \`${fullCmd}\``);
    }
  }

  return sections.join("\n");
}
