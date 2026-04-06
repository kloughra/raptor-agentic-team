---
slug: dino-agent-names
spec: docs/specs/dino-agent-names.md
---
# Dinosaur Agent Names — Architecture Design

## Overview
Add dinosaur-themed identities to each agent role. Names appear in progress tables, system prompts, handoff commits, and checkpoint prompts. Configurable via `~/.raptor/config.json`.

## Components

### 1. Dino Identity Module (`src/orchestrator/dino.ts`)
New module defining the name mapping and resolution:

```typescript
interface DinoIdentity {
  role: Role;
  species: string;
  nickname: string;
  emoji: string;
  tagline: string;
}

const DEFAULT_DINO_NAMES: Record<Role, DinoIdentity> = {
  po: { role: "po", species: "Pteranodon", nickname: "Petra", emoji: "🦅", tagline: "soars above, sees the big picture" },
  architect: { role: "architect", species: "Ankylosaurus", nickname: "Anky", emoji: "🛡️", tagline: "armored, builds solid structures" },
  qa: { role: "qa", species: "Velociraptor", nickname: "Vex", emoji: "🔍", tagline: "sharp-eyed, catches everything" },
  engineer: { role: "engineer", species: "Triceratops", nickname: "Trix", emoji: "🔨", tagline: "charges through implementation" },
  team: { role: "team", species: "Brachiosaurus", nickname: "Brax", emoji: "🦕", tagline: "towers over the whole picture" },
};

function resolveDinoNames(configOverrides?: Partial<Record<Role, Partial<DinoIdentity>>>): Record<Role, DinoIdentity>
function formatRoleDisplay(role: Role, names: Record<Role, DinoIdentity>): string  // "🔍 Vex (QA)"
function formatHandoffRole(role: Role, names: Record<Role, DinoIdentity>): string  // "Vex (QA)"
```

### 2. Config Extension (`src/config.ts`)
Add optional `dinoNames` field to `RaptorConfig`:

```typescript
interface RaptorConfig {
  // ... existing
  dinoNames?: Partial<Record<string, { species?: string; nickname?: string; emoji?: string }>>;
}
```

### 3. Integration Points

**Progress table** (`progress.ts`):
- Role column changes from "PO" to "🦅 Petra (PO)"
- `renderProgressTable` accepts an optional `DinoIdentity` map

**System prompts** (`prompts.ts`):
- Prepend role identity to system prompt: "You are Vex the Velociraptor — the QA Engineer on an agentic dev team."
- `buildRolePrompt` accepts optional `DinoIdentity`

**Handoff commits** (`runner.ts`):
- Change `[HANDOFF] PO -> ARCHITECT` to `[HANDOFF] Petra (PO) -> Anky (Architect)`

**Checkpoint prompts** (`checkpoints.ts`):
- Include dino name: "Petra (PO) is requesting your review of the specification..."

**Escalation commits** (`runner.ts`):
- Include dino name: `[ESCALATE] Vex (QA): step 7 failed...`

## Data Model
No state schema changes. Dino names are resolved at runtime from config + defaults.

## API Contracts
`get_project_status` response includes a `dinoNames` field showing the resolved name mapping for the project.

## Non-Functional Requirements
- Name resolution is synchronous and cached per sprint run (config read once)
- No external dependencies

## Technology Choices

| Area | Choice | Rationale |
|------|--------|-----------|
| Storage | Config JSON | Simple, user-editable, optional override |
| Resolution | Defaults + merge | Missing overrides fall back gracefully |

## Constraints & Patterns
- Role keys (`po`, `architect`, etc.) remain canonical everywhere in code and state
- Dino names are display-only — never used as identifiers in state or logic
- Emoji selection avoids actual dinosaur emoji (🦕🦖) for most roles to maintain visual distinction in the progress table
