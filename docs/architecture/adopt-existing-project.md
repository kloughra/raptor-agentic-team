---
slug: adopt-existing-project
spec: docs/specs/adopt-existing-project.md
---
# Adopt Existing Project — Architecture Design

## Overview
Add an `adopt_project` MCP tool that registers an existing git repo with Raptor, scaffolds only missing pieces, and generates a project context summary from existing files. This enables running the full sprint workflow on repos not created by `bootstrap_project`.

## Components

### 1. Adopt Tool (`src/tools.ts`)
New `adoptProject` function alongside the existing `bootstrapProject`:

```typescript
async function adoptProject(
  ctx: ToolContext,
  args: { path: string; name: string; description: string; featureIdeas?: string[] }
): Promise<Record<string, unknown>>
```

Validation sequence:
1. Check name format (`^[a-z][a-z0-9-]*$`)
2. Check name not already registered
3. Check path exists and is a directory
4. Check path not already registered (by path, not name)
5. Check path is a git repo (`.git/` exists or `git rev-parse --git-dir` succeeds)

### 2. Additive Scaffold (`src/template.ts`)
New `scaffoldAdoptedProject` function that only creates missing files:

```typescript
function scaffoldAdoptedProject(
  projectPath: string,
  templatePath: string,
  description: string,
  featureIdeas?: string[]
): { scaffoldedFiles: string[]; skippedFiles: string[] }
```

Logic per file/directory:
- `TEAM.md` → write only if `!fs.existsSync`
- `docs/backlog.md` → write only if `!fs.existsSync`
- Each `SCAFFOLD_DIRS` entry → `mkdirSync` + `.gitkeep` only if dir doesn't exist
- `README.md` → always skip (never touch)

### 3. Context Discovery (`src/orchestrator/context-discovery.ts`)
New module that reads existing repo files to build a structured context:

```typescript
interface ProjectContext {
  description: string;
  techStack: string[];
  codebaseLayout: string;
  existingDocs: string[];
  keyFiles: Array<{ path: string; summary: string }>;
}

function discoverProjectContext(projectPath: string, maxTotalChars?: number): ProjectContext
function generateContextDocument(context: ProjectContext, projectName: string): string
```

Discovery sources (in order):
1. `README.md` → project description, goals
2. `package.json` / `pyproject.toml` / `Cargo.toml` → tech stack, dependencies
3. Directory tree (top 2 levels) → codebase layout
4. `docs/**/*.md` → existing documentation (titles and first paragraph)
5. `src/` or equivalent → key source files (read first 50 lines of entry points)

Size bounding: 10KB per file, 50KB total. Binary files skipped.

Output: `docs/project-context.md` — written only if it doesn't exist.

### 4. MCP Registration (`src/index.ts`)
Register `adopt_project` as a new tool with Zod schema validation:

```typescript
server.tool("adopt_project", "Adopt an existing repository...", { path, name, description, featureIdeas }, handler)
```

### 5. Registry Extension (`src/registry.ts`)
Add `findProjectByPath` method to check for duplicate path registration:

```typescript
async findProjectByPath(projectPath: string): Promise<ProjectEntry | null>
```

## Data Model
No new state types. Uses existing `ProjectEntry` in the registry. The `project-context.md` file is a plain markdown file, not structured data.

## API Contracts

New MCP tool:
| Tool | Parameters | Returns |
|------|-----------|---------|
| `adopt_project` | `path`, `name`, `description`, `featureIdeas?` | `{ status, project, scaffoldedFiles, skippedFiles, contextDiscovered }` |

## Non-Functional Requirements
- Context discovery must complete in <5 seconds for repos up to 10,000 files
- File reads are bounded (10KB per file, 50KB total) to prevent memory issues on large repos
- Never modify existing files — additive only

## Technology Choices

| Area | Choice | Rationale |
|------|--------|-----------|
| File detection | `fs.existsSync` | Simple, synchronous, matches existing patterns |
| Tech stack detection | Package manifest reading | Reliable, no external tools needed |
| Context size | 50KB cap | Fits in agent context windows without truncation |

## Constraints & Patterns
- Additive-only: check existence before every write
- Context discovery is best-effort: failures don't block adoption
- Registry dedup by both name AND path
