import * as fs from "fs";
import * as path from "path";

const DEFAULT_MAX_ARTIFACT_SIZE = 10 * 1024; // 10KB per artifact

export interface ArtifactRequirement {
  pattern: string;       // path pattern with {slug} placeholder
  label: string;         // human-readable label
  required: boolean;     // if true, missing artifact fails the step
}

export interface InjectedArtifact {
  label: string;
  path: string;
  content: string;
}

export interface ArtifactInjectionResult {
  artifacts: InjectedArtifact[];
  missing: string[];
  checklist: string;
  section: string;
}

/**
 * Step-to-artifact requirements mapping.
 * Keys are step names from SPRINT_WORKFLOW.
 */
export const STEP_ARTIFACT_REQUIREMENTS: Record<string, ArtifactRequirement[]> = {
  "Architecture design": [
    { pattern: "docs/specs/{slug}.md", label: "Feature Specification", required: true },
  ],
  "Write tests": [
    { pattern: "docs/specs/{slug}.md", label: "Feature Specification", required: true },
    { pattern: "docs/architecture/{slug}.md", label: "Architecture Design", required: true },
  ],
  "Review tests": [
    { pattern: "docs/specs/{slug}.md", label: "Feature Specification", required: true },
    { pattern: "tests/bdd/{slug}.feature", label: "BDD Scenarios", required: true },
  ],
  "Implement (TDD)": [
    { pattern: "docs/specs/{slug}.md", label: "Feature Specification", required: true },
    { pattern: "docs/architecture/{slug}.md", label: "Architecture Design", required: true },
    { pattern: "tests/bdd/{slug}.feature", label: "BDD Scenarios", required: true },
    { pattern: "tests/integration/{slug}.integration.test.ts", label: "Integration Tests", required: false },
  ],
  // Steps without artifact requirements
  "Open PR": [],
  "Run test suite": [],
  "Demo": [],
  "Merge PR": [],
};

/**
 * Resolve artifact requirements for a step: read files from disk, report missing ones.
 */
export function resolveArtifacts(
  stepName: string,
  featureSlug: string,
  projectPath: string,
  customRequirements?: ArtifactRequirement[],
  maxArtifactSize?: number
): ArtifactInjectionResult {
  const cap = maxArtifactSize ?? DEFAULT_MAX_ARTIFACT_SIZE;
  const baseReqs = STEP_ARTIFACT_REQUIREMENTS[stepName];

  // If step has no requirements defined, return empty
  if (!baseReqs || baseReqs.length === 0) {
    if (!customRequirements || customRequirements.length === 0) {
      return { artifacts: [], missing: [], checklist: "", section: "" };
    }
  }

  const allReqs = [...(baseReqs || []), ...(customRequirements || [])];
  const artifacts: InjectedArtifact[] = [];
  const missing: string[] = [];

  for (const req of allReqs) {
    const resolvedPath = req.pattern.replace("{slug}", featureSlug);
    const fullPath = path.join(projectPath, resolvedPath);

    // Only regular files count as artifacts. A directory at the resolved
    // path (e.g. the Sprint-8 workaround dir at tests/integration/{slug})
    // is treated exactly like an absent artifact: required → reported
    // missing, optional → silently skipped. statSync follows symlinks, so
    // a symlink to a file reads normally and a symlink to a directory is
    // skipped. Never throws (EISDIR/ENOENT degrade to not-a-file).
    let isFile = false;
    try {
      isFile = fs.statSync(fullPath).isFile();
    } catch {
      isFile = false; // absent path, broken symlink, or unreadable
    }

    if (!isFile) {
      if (req.required) {
        missing.push(resolvedPath);
      }
      continue;
    }

    try {
      const content = fs.readFileSync(fullPath, "utf-8");
      artifacts.push({
        label: req.label,
        path: resolvedPath,
        content: content.slice(0, cap),
      });
    } catch {
      if (req.required) {
        missing.push(resolvedPath);
      }
    }
  }

  const checklist = buildChecklist(artifacts);
  const section = artifacts.length > 0
    ? buildRequiredReadingSection({ artifacts, missing, checklist, section: "" })
    : "";

  return { artifacts, missing, checklist, section };
}

/**
 * Build a checklist string for the agent to acknowledge.
 */
function buildChecklist(artifacts: InjectedArtifact[]): string {
  if (artifacts.length === 0) return "";

  const items = artifacts.map((a) => `- [ ] I have read the ${a.label} and understand its contents`);
  return items.join("\n");
}

/**
 * Build the full "## Required Reading" section for injection into task description.
 */
export function buildRequiredReadingSection(result: ArtifactInjectionResult): string {
  if (result.artifacts.length === 0) return "";

  const sections: string[] = [];
  sections.push("\n## Required Reading");
  sections.push("Before generating any output, confirm you have reviewed all artifacts below.\n");

  for (const artifact of result.artifacts) {
    sections.push(`### ${artifact.label}`);
    sections.push(`*Source: ${artifact.path}*\n`);
    sections.push(artifact.content);
    sections.push("");
  }

  sections.push("## Pre-Generation Checklist");
  for (const artifact of result.artifacts) {
    sections.push(`- [ ] I have read the ${artifact.label} and understand its contents`);
  }
  sections.push("");

  return sections.join("\n");
}
