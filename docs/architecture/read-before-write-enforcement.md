# Read-Before-Write Enforcement — Architecture Design

## Overview
Add a structured discovery phase to each workflow step. Before an agent generates output, its required input artifacts are read from disk and injected directly into the task description. Missing artifacts fail the step explicitly rather than letting agents proceed blindly.

## Components

### 1. `src/orchestrator/artifact-injection.ts` (new module)
Maps each workflow step to its required input artifacts and handles reading + injection.

```typescript
export interface ArtifactRequirement {
  pattern: string;       // glob-like pattern, e.g. "docs/specs/{slug}.md"
  label: string;         // human-readable label, e.g. "Feature Specification"
  required: boolean;     // if true, missing artifact fails the step
}

export interface InjectedArtifact {
  label: string;
  path: string;
  content: string;
}

export interface ArtifactInjectionResult {
  artifacts: InjectedArtifact[];
  missing: string[];           // paths that were required but not found
  checklist: string;           // markdown checklist for the agent
  section: string;             // full "## Required Reading" section
}

// Step → artifact requirements mapping
export const STEP_ARTIFACT_REQUIREMENTS: Record<string, ArtifactRequirement[]>;

export function resolveArtifacts(
  stepName: string,
  featureSlug: string,
  projectPath: string,
  customRequirements?: ArtifactRequirement[]
): ArtifactInjectionResult;

export function buildRequiredReadingSection(result: ArtifactInjectionResult): string;
```

**Step-to-artifact mapping:**

| Step | Required Artifacts |
|------|-------------------|
| Architecture design | spec |
| Write tests | spec, architecture |
| Review tests | spec, tests |
| Implement (TDD) | spec, architecture, BDD scenarios, integration tests |
| Open PR | (none — no reading required) |
| Run test suite | (none — runs commands, not reads) |

### 2. Changes to `src/orchestrator/runner.ts`
In the standard agent step loop, before building the task description:

```typescript
// Resolve and inject artifacts
const injectionResult = resolveArtifacts(step.name, featureSlug, projectPath);

// Fail fast if required artifacts are missing
if (injectionResult.missing.length > 0) {
  // Record as step failure, not escalation — the prior step didn't produce its output
  stepState.failures.push({
    attempt,
    errorSummary: `Missing required artifacts: ${injectionResult.missing.join(", ")}`,
    timestamp: new Date().toISOString(),
    hadPartialArtifacts: false,
  });
  // Continue to next retry attempt (artifact might appear if prior step is retried)
  continue;
}

// Inject into task description
const taskDesc = buildTaskDescription(step, featureSlug, sprint, feedback, testScopeSection, injectionResult.section);
```

### 3. Changes to `buildTaskDescription` in `runner.ts`
Add an optional `requiredReadingSection` parameter that gets injected before the commit format instruction:

```typescript
function buildTaskDescription(
  step: WorkflowStep,
  featureSlug: string,
  sprint: number,
  feedback?: string,
  testScopeSection?: string,
  requiredReadingSection?: string
): string {
  // ... existing logic ...
  if (requiredReadingSection) {
    task += requiredReadingSection;
  }
  // ... commit format instruction ...
}
```

### 4. Handoff commit enrichment
After a step completes, the handoff commit message includes which artifacts were consumed:
```
[HANDOFF] Trix (QA) -> Petra (PO): test cases for feature-slug
Consumed: docs/specs/feature-slug.md, docs/architecture/feature-slug.md
```

### 5. Config extension in `src/config.ts`
```typescript
artifactInjection?: {
  customRequirements?: Record<string, ArtifactRequirement[]>; // per-step overrides
  maxArtifactSize?: number;  // per-artifact content cap (default 10KB)
}
```

## Required Reading Section Format
Injected into the agent's task description:

```markdown
## Required Reading
Before generating any output, confirm you have reviewed all artifacts below.

### Feature Specification
<content of docs/specs/{slug}.md>

### Architecture Design
<content of docs/architecture/{slug}.md>

### BDD Scenarios
<content of tests/bdd/{slug}.feature>

### Integration Tests
<content of tests/integration/{slug}.integration.test.ts>

## Pre-Generation Checklist
- [ ] I have read the Feature Specification and understand all acceptance criteria
- [ ] I have read the Architecture Design and will follow its patterns
- [ ] I have read the BDD Scenarios and my output will satisfy them
- [ ] I have read the Integration Tests and my code will pass them
```

## Relationship to Existing `buildStepContext`
The existing `buildStepContext` function in `prompts.ts` already reads input artifacts via `step.inputArtifacts`. The new artifact injection system **replaces** this for steps that have defined requirements in `STEP_ARTIFACT_REQUIREMENTS`, and falls back to the existing behavior for steps without explicit requirements.

Over time, `buildStepContext` becomes the fallback/legacy path, and `resolveArtifacts` becomes the primary.

## Non-Functional Requirements
- Artifact reading must complete in < 100ms for typical project sizes
- Per-artifact content cap of 10KB (configurable) to prevent prompt bloat
- Total injected content should stay under 50KB including the checklist

## Constraints
- Only checks file existence — does not verify file quality or completeness
- Checklist is advisory — we cannot enforce that the LLM actually processes each section
- Multi-feature sprints resolve artifacts per feature slug (no cross-feature artifact loading)
