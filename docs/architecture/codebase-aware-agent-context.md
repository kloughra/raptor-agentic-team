# Codebase-Aware Agent Context — Architecture Design

## Overview
Add a codebase snapshot system that generates a structured view of the project's current state and injects it into every agent's context. Leverages the existing `context-discovery.ts` module (Sprint 6) and extends it from adoption-time-only to per-step runtime use.

## Components

### 1. `src/orchestrator/codebase-context.ts` (new module)
Builds a codebase snapshot tailored for agent consumption during sprint execution.

```typescript
export interface CodebaseSnapshot {
  directoryTree: string;        // filtered tree (exclude .gitignore, node_modules, dist, etc.)
  moduleExports: ModuleExport[]; // { path, exports[] } from source files
  keyFileExcerpts: FileExcerpt[]; // { path, content } capped per file
  dependencies: string[];        // from package.json / Cargo.toml / pyproject.toml
  totalSize: number;             // bytes used, for cap enforcement
}

export interface ModuleExport {
  path: string;
  exports: string[];  // exported function/class/const names
}

export interface FileExcerpt {
  path: string;
  content: string;  // truncated to per-file cap
}

export function buildCodebaseSnapshot(projectPath: string, config?: CodebaseContextConfig): CodebaseSnapshot;
export function formatSnapshotForPrompt(snapshot: CodebaseSnapshot): string;
```

**Key design decisions:**
- **Reuse `context-discovery.ts` internals** — `buildDirectoryTree`, `detectTechStack`, `readFileBounded` are already battle-tested. Import and extend rather than duplicate.
- **Export extraction** uses regex matching for TS/JS (`export (function|class|const|interface|type)`) and Python (`def |class `). No AST parsing — text-based is sufficient and fast.
- **Size cap** defaults to 30KB, configurable via `~/.raptor/config.json` → `codebaseContext.maxSize`. Per-file cap is 3KB (enough for signatures and structure, not full implementations).

### 2. Changes to `src/orchestrator/runner.ts`
- Call `buildCodebaseSnapshot(projectPath)` inside the step loop (not once at sprint start) so each agent sees changes from prior steps
- Pass the formatted snapshot to `buildStepContext` or append it to the context string
- Only inject for sprint > 1 (first sprint has no existing codebase worth snapshotting)

### 3. Changes to `src/orchestrator/prompts.ts`
- New function `injectCodebaseContext(baseContext: string, snapshot: string): string` that prepends a `## Codebase Context` section
- Keeps sprint summary context (from Sprint 4) separate — they serve different purposes

### 4. Config extension in `src/config.ts`
```typescript
codebaseContext?: {
  maxSize?: number;       // total cap in bytes (default 30KB)
  maxPerFile?: number;    // per-file excerpt cap (default 3KB)
  excludePatterns?: string[]; // additional exclude globs
}
```

## Data Flow
```
Step loop iteration
  → buildCodebaseSnapshot(projectPath, config)
  → formatSnapshotForPrompt(snapshot)
  → context = sprintSummaries + codebaseSnapshot + stepArtifacts
  → spawnAgent(role, systemPrompt, context, taskDesc, ...)
```

## Exclusion Rules
Default exclusions (not configurable — always excluded):
- `.git/`, `node_modules/`, `dist/`, `build/`, `target/`, `__pycache__/`
- Binary files (reuse `BINARY_EXTENSIONS` from context-discovery.ts)
- `.gitignore`'d files (read `.gitignore` and apply basic glob matching)

User-configurable additional exclusions via `config.codebaseContext.excludePatterns`.

## Non-Functional Requirements
- Snapshot generation must complete in < 500ms for repos up to 10K files
- Memory usage bounded by `maxSize` cap — never buffer more than cap
- No file system writes — snapshot is ephemeral, built in memory per step

## Constraints
- Reuse existing `context-discovery.ts` helpers — do not duplicate `buildDirectoryTree`, `detectTechStack`, `readFileBounded`
- Export extraction is best-effort regex — false positives are acceptable, false negatives for common patterns are not
- `.gitignore` parsing is basic (literal patterns and simple globs) — no full gitignore spec compliance needed
