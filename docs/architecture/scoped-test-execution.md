---
slug: scoped-test-execution
spec: docs/specs/scoped-test-execution.md
---
# Scoped Test Execution — Architecture Design

## Overview
Add test scoping to the agent task descriptions so engineers run only feature-specific tests during implementation, with the full suite reserved for step 7 (QA test run). Includes shared config file protection and test framework auto-detection.

## Components

### 1. Test Scope Module (`src/orchestrator/test-scope.ts`)
New module for test command resolution and scoping:

```typescript
type TestFramework = "jest" | "pytest" | "cargo" | "unknown";

interface TestScopeConfig {
  framework?: TestFramework;
  testCommand?: string;          // Custom command with {slug} placeholder
  scopedPattern?: string;        // Custom scoped pattern with {slug} placeholder
}

function detectTestFramework(projectPath: string): TestFramework
function buildScopedTestCommand(framework: TestFramework, featureSlug: string, config?: TestScopeConfig): string
function buildFullTestCommand(framework: TestFramework, config?: TestScopeConfig): string
```

Auto-detection logic:
1. `package.json` exists → `"jest"` (check for jest in devDependencies for confidence)
2. `pyproject.toml` or `setup.py` exists → `"pytest"`
3. `Cargo.toml` exists → `"cargo"`
4. Otherwise → `"unknown"`

Scoped commands:
- jest: `npx jest --testPathPattern="{slug}"`
- pytest: `pytest -k "{slug}"`
- cargo: `cargo test {slug}`
- unknown: no scoping (agent decides)

### 2. Task Description Extension (`src/orchestrator/runner.ts`)
`buildTaskDescription` gains a `testScope` section for engineer steps:

```typescript
// During step 5 (implementation):
task += `\n## Test Scope\n`;
task += `Run ONLY tests matching your feature: \`${scopedCommand}\`\n`;
task += `Do NOT run the full test suite — other features are being worked on in parallel.\n`;

// Shared config warning (when multi-feature):
task += `\n## Shared File Warning\n`;
task += `Do NOT modify shared config files (jest.config.js, pyproject.toml, tsconfig.json, etc.).\n`;
task += `These are shared across features. If a config change is needed, raise a [BLOCKER].\n`;
```

For step 7 (QA test run):
```typescript
task += `\nRun the FULL test suite: \`${fullCommand}\`\n`;
```

### 3. Config Extension (`src/config.ts`)
Add optional `testConfig` field:

```typescript
interface RaptorConfig {
  // ... existing
  testConfig?: {
    framework?: "jest" | "pytest" | "cargo";
    testCommand?: string;      // e.g., "npm test -- --testPathPattern={slug}"
    scopedPattern?: string;    // e.g., "--testPathPattern={slug}"
  };
}
```

### 4. Feature Slug Escaping (`src/orchestrator/test-scope.ts`)
Escape feature slugs for use in test patterns:

```typescript
function escapeForTestPattern(slug: string): string {
  // Escape regex special chars that might appear in slugs
  return slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
```

In practice, slugs are `^[a-z][a-z0-9-]*$` so only hyphens need attention, but the escaping is defensive.

## Data Model
No state schema changes. Test scope is resolved at runtime per step.

## API Contracts
No new MCP tools. Test scoping is transparent — it modifies what the agent is told to do, not what the orchestrator does.

## Non-Functional Requirements
- Framework detection is synchronous (single `fs.existsSync` per check)
- No new dependencies

## Technology Choices

| Area | Choice | Rationale |
|------|--------|-----------|
| Detection | Package manifest existence | Reliable, no `which` or shell commands needed |
| Scoping | Task description injection | Agent follows instructions; no wrapper scripts needed |
| Config | Existing `config.json` | Consistent with other config patterns |

## Constraints & Patterns
- Test scoping is advisory — the agent sees it in the task description but isn't forced
- The shared config warning is only injected during multi-feature sprints (when `state.features` is present)
- Framework detection runs once per sprint, cached in the runner
- Custom `testCommand` with `{slug}` placeholder takes full precedence over auto-detection
