import * as fs from "fs";
import * as path from "path";
import { Role, WorkflowStep } from "./workflow";
import { spawnAgent, AgentResult } from "./agents";

const MAX_SUB_TASKS = 6;

export interface SubTask {
  id: string;
  description: string;
  scope: string;
  inputContext: string;
}

export interface NarrowingResult {
  strategy: string;
  subTasks: SubTask[];
  completedIds: string[];
  failedIds: string[];
  aggregatedOutput: string;
  partialProgress: boolean;
}

export interface NarrowingConfig {
  enabled: boolean;
  disabledSteps?: string[];
}

/**
 * Check if a role supports scope narrowing.
 */
export function isNarrowable(role: Role): boolean {
  return role === "engineer" || role === "qa" || role === "architect";
}

/**
 * Decompose a failed task into sub-tasks based on role-specific strategy.
 */
export function decomposeTask(
  role: Role,
  step: WorkflowStep,
  featureSlug: string,
  projectPath: string,
  originalTaskDesc: string,
  config?: NarrowingConfig
): SubTask[] {
  // Check config
  if (config && !config.enabled) return [];
  if (config?.disabledSteps?.includes(step.name)) return [];

  if (!isNarrowable(role)) return [];

  // Read the spec for decomposition
  const specPath = path.join(projectPath, "docs", "specs", `${featureSlug}.md`);
  let specContent = "";
  if (fs.existsSync(specPath)) {
    try {
      specContent = fs.readFileSync(specPath, "utf-8");
    } catch {
      return [];
    }
  } else {
    return [];
  }

  switch (role) {
    case "engineer":
      return decomposeByAcceptanceCriteria(specContent, featureSlug, originalTaskDesc);
    case "qa":
      return decomposeByScenarioGroup(specContent, featureSlug, originalTaskDesc);
    case "architect":
      return decomposeByComponent(specContent, featureSlug, originalTaskDesc);
    default:
      return [];
  }
}

/**
 * Engineer decomposition: split by acceptance criteria.
 */
function decomposeByAcceptanceCriteria(
  specContent: string,
  featureSlug: string,
  originalTaskDesc: string
): SubTask[] {
  const criteria = extractAcceptanceCriteria(specContent);
  if (criteria.length <= 1) return [];

  const capped = criteria.slice(0, MAX_SUB_TASKS);
  return capped.map((criterion, i) => ({
    id: `ac-${i + 1}`,
    description: `Implement ONLY the following acceptance criterion for ${featureSlug}:\n\n${criterion}\n\nDo not implement other criteria. Focus on making this single criterion pass.`,
    scope: `Acceptance criterion ${i + 1}: ${criterion.slice(0, 80)}`,
    inputContext: originalTaskDesc,
  }));
}

/**
 * QA decomposition: split by scenario group (happy path, error, edge).
 */
function decomposeByScenarioGroup(
  specContent: string,
  featureSlug: string,
  originalTaskDesc: string
): SubTask[] {
  const criteria = extractAcceptanceCriteria(specContent);
  if (criteria.length < 2) return [];

  // Categorize criteria into groups
  const happyPath: string[] = [];
  const errorCases: string[] = [];
  const edgeCases: string[] = [];

  for (const c of criteria) {
    const lower = c.toLowerCase();
    if (lower.includes("error") || lower.includes("invalid") || lower.includes("fail") ||
        lower.includes("reject") || lower.includes("denied") || lower.includes("unauthorized")) {
      errorCases.push(c);
    } else if (lower.includes("edge") || lower.includes("boundary") || lower.includes("empty") ||
               lower.includes("maximum") || lower.includes("minimum") || lower.includes("limit") ||
               lower.includes("timeout") || lower.includes("expire")) {
      edgeCases.push(c);
    } else {
      happyPath.push(c);
    }
  }

  const groups: SubTask[] = [];

  if (happyPath.length > 0) {
    groups.push({
      id: "group-happy-path",
      description: `Write BDD scenarios and integration tests for the HAPPY PATH cases only for ${featureSlug}:\n\n${happyPath.map((c) => `- ${c}`).join("\n")}`,
      scope: "Happy path / success scenarios",
      inputContext: originalTaskDesc,
    });
  }

  if (errorCases.length > 0) {
    groups.push({
      id: "group-error-cases",
      description: `Write BDD scenarios and integration tests for the ERROR / FAILURE cases only for ${featureSlug}:\n\n${errorCases.map((c) => `- ${c}`).join("\n")}`,
      scope: "Error / failure scenarios",
      inputContext: originalTaskDesc,
    });
  }

  if (edgeCases.length > 0) {
    groups.push({
      id: "group-edge-cases",
      description: `Write BDD scenarios and integration tests for the EDGE CASES only for ${featureSlug}:\n\n${edgeCases.map((c) => `- ${c}`).join("\n")}`,
      scope: "Edge case / boundary scenarios",
      inputContext: originalTaskDesc,
    });
  }

  // If everything fell into one group, not worth narrowing
  if (groups.length <= 1) return [];

  return groups.slice(0, MAX_SUB_TASKS);
}

/**
 * Architect decomposition: split by component.
 */
function decomposeByComponent(
  specContent: string,
  featureSlug: string,
  originalTaskDesc: string
): SubTask[] {
  const components = extractComponents(specContent);
  if (components.length <= 1) return [];

  const capped = components.slice(0, MAX_SUB_TASKS);
  return capped.map((component, i) => ({
    id: `component-${i + 1}`,
    description: `Design the architecture for the following component ONLY for ${featureSlug}:\n\n${component}\n\nFocus on this component's internal design, API surface, and integration points.`,
    scope: `Component: ${component.slice(0, 80)}`,
    inputContext: originalTaskDesc,
  }));
}

/**
 * Extract acceptance criteria lines from a spec.
 */
function extractAcceptanceCriteria(specContent: string): string[] {
  const criteria: string[] = [];

  // Match lines like "- [ ] Some criterion" or "- [x] Some criterion"
  const lines = specContent.split("\n");
  let inCriteriaSection = false;

  for (const line of lines) {
    // Detect acceptance criteria section
    if (/^#+\s*acceptance\s+criteria/i.test(line)) {
      inCriteriaSection = true;
      continue;
    }
    // End section on next heading
    if (inCriteriaSection && /^#+\s/.test(line) && !/acceptance/i.test(line)) {
      break;
    }
    if (inCriteriaSection) {
      const match = line.match(/^[-*]\s*\[[ x]\]\s*(.+)/);
      if (match) {
        criteria.push(match[1].trim());
      }
    }
  }

  return criteria;
}

/**
 * Extract component names from a spec (under ## Components or as bullet points).
 */
function extractComponents(specContent: string): string[] {
  const components: string[] = [];
  const lines = specContent.split("\n");
  let inComponentsSection = false;

  for (const line of lines) {
    if (/^#+\s*components/i.test(line)) {
      inComponentsSection = true;
      continue;
    }
    if (inComponentsSection && /^#+\s/.test(line) && !/components/i.test(line)) {
      break;
    }
    if (inComponentsSection) {
      const match = line.match(/^[-*]\s+(.+)/);
      if (match) {
        components.push(match[1].trim());
      }
    }
  }

  return components;
}

/**
 * Execute sub-tasks sequentially and aggregate results.
 */
export async function executeNarrowedRetry(
  subTasks: SubTask[],
  role: Role,
  systemPrompt: string,
  baseContext: string,
  projectPath: string,
  timeoutMs: number
): Promise<NarrowingResult> {
  const completedIds: string[] = [];
  const failedIds: string[] = [];
  const outputs: string[] = [];

  for (const subTask of subTasks) {
    const context = `${baseContext}\n\n--- NARROWED SCOPE ---\nThis is a narrowed retry. Focus ONLY on: ${subTask.scope}\n`;

    try {
      const result: AgentResult = await spawnAgent(
        role,
        systemPrompt,
        context,
        subTask.description,
        projectPath,
        timeoutMs
      );

      if (result.exitCode === 0) {
        completedIds.push(subTask.id);
        outputs.push(`--- ${subTask.scope} ---\n${result.output}`);
      } else {
        failedIds.push(subTask.id);
      }
    } catch {
      failedIds.push(subTask.id);
    }
  }

  const strategy = role === "engineer" ? "by-acceptance-criteria"
    : role === "qa" ? "by-scenario-group"
    : "by-component";

  return {
    strategy,
    subTasks,
    completedIds,
    failedIds,
    aggregatedOutput: outputs.join("\n\n"),
    partialProgress: completedIds.length > 0 && failedIds.length > 0,
  };
}
