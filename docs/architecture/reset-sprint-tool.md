---
slug: reset-sprint-tool
spec: docs/specs/reset-sprint-tool.md
---
# Reset Sprint Tool — Architecture Design

## Overview

`reset_sprint` becomes Raptor's **seventh** MCP tool: the deliberate complement to
`resume_sprint`. Where `resume_sprint` re-engages a *parked* sprint and carries the
user's directional feedback into a re-attempt, `reset_sprint` **clears** the persisted
per-sprint orchestration state so a subsequent `run_sprint {slug} {N}` starts that sprint
over from step 1 with a clean slate. It is the first-class replacement for the manual
`rm ~/.raptor/{project}/sprint-N.json` escape hatch, and its whole reason to exist is to
free a sprint from a status `resume_sprint` refuses — most importantly the un-resumable
`in-progress` limbo at `runner.ts:1818`.

The design is intentionally **small, decoupled, and side-effect-minimal**: one new tool
function in `src/tools.ts`, one thin registration in `src/index.ts`, and one new
encapsulated state helper in `src/orchestrator/state.ts`. There is **no** shared control
flow with `resumeSprint` and **no** call into `runSprintFromStep` — reset clears state and
stops (AC 11). No state-schema change; no new config surface.

### Mechanism decision (Open Question 1): delete the file

Reset **`fs.rmSync`-deletes** `~/.raptor/{slug}/sprint-{N}.json` rather than rewriting it
to `createInitialState(...)`. Rationale:

- **Byte-identical to the manual `rm` it replaces.** `run_sprint`'s very first invocation
  on any sprint already runs against *no* state file — `runSprintFromStep` builds the
  clean initial state itself. Deleting the file returns the sprint to exactly that
  pre-first-run condition, which provably satisfies AC 4's clean-slate post-condition with
  zero coupling to how step 1 seeds state.
- **No signature coupling.** `createInitialState(project, sprint, steps[], branchName)`
  requires the workflow step list and branch name; a rewrite path would force the reset
  tool to reconstruct those (and to know whether the sprint is single- vs multi-feature).
  Deletion needs none of it.
- **Minimal blast radius.** One `unlink`, no serialization, no risk of writing a subtly
  wrong "initial" shape that drifts from what `run_sprint` would produce.

## Components

| Component | Location | Responsibility | New / Changed |
|-----------|----------|----------------|---------------|
| `deleteSprintState(projectSlug, sprint)` | `src/orchestrator/state.ts` | Encapsulates path resolution + deletion. Returns `boolean` (a file existed and was removed). Throws only on a genuine FS failure (EPERM/EACCES). | **New** |
| Export of `deleteSprintState` | `src/orchestrator/index.ts` | Re-export alongside `loadSprintState`/`saveSprintState`. | **New** |
| `resetSprintTool(ctx, args)` | `src/tools.ts` | Tool implementation: project resolution → prior-status read → complete-guard → delete → structured result. Never throws to the transport. | **New** |
| `reset_sprint` registration | `src/index.ts` | Zod schema + handler mirroring `run_sprint`/`resume_sprint`; maps result to MCP `content[]`. | **New** |

`sprintStatePath` stays **private** to `state.ts` — the reset tool never resolves the path
itself; it goes through `loadSprintState` (to read the prior status) and the new
`deleteSprintState` (to clear it). This keeps state-file location knowledge in one module.

### Control flow (`resetSprintTool`)

```
1. project = ctx.registry.findProject(name)
   └─ !project                         → { status: "error", message: "Project '<name>' not found." }
2. !fs.existsSync(project.path)         → { status: "error", message: "Project directory missing at '<path>'." }
3. state = loadSprintState(name, sprint)     // projectSlug == args.name, matching run/resume
   └─ state === null                    → { status: "success", priorStatus: "none", ...no-op message }   (AC 6)
4. state.status === "complete" && !confirm
                                        → { status: "error", priorStatus: "complete", ...how-to-force }   (AC 7)
5. try { existed = deleteSprintState(name, sprint) }
   catch (err)                          → { status: "error", message: "Failed to clear sprint state: <err>" } (AC 10)
6. return { status: "success", priorStatus: state.status, summary, nextAction }        (AC 4, 5, 9)
```

Steps 4 and 5 are the only branches beyond the resolution parity shared with the existing
tools. Note that `escalated`, `failed`, `in-progress`, and `paused` all fall straight
through to the delete at step 5 with **no** guard — freeing those is the point (AC 5).

## Data Model

**No new persisted state and no schema change.** `SprintState` is untouched. The tool is a
pure reader-then-deleter of the existing `~/.raptor/{slug}/sprint-{N}.json` file.

New state helper:

```ts
// src/orchestrator/state.ts
export function deleteSprintState(projectSlug: string, sprint: number): boolean {
  const filePath = sprintStatePath(projectSlug, sprint);
  if (!fs.existsSync(filePath)) return false;   // idempotent: nothing to remove
  fs.rmSync(filePath);                           // throws on unwritable/undeletable → tool catches (AC 10)
  return true;
}
```

The tool derives an optional one-line **discarded-state summary** from the loaded state for
auditability (Open Question 3) — prior status plus completed-step counts — without
persisting anything or emitting a log line (Open Question 4: fire-and-forget accepted for
this sprint):

```
summary = `${completedSteps}/${totalSteps} steps complete, status '${state.status}'`
```

## API Contracts

### MCP tool: `reset_sprint`

**Description (surfaced to callers):** "Clear the persisted state for a sprint so a fresh
`run_sprint` starts it over from step 1. Frees a sprint wedged in any status —
`escalated`, `failed`, `in-progress`, or `paused` — that `resume_sprint` cannot re-engage.
Does NOT carry feedback, re-run the sprint, or touch git branches, PRs, committed
artifacts, summaries, the backlog, or the registry — only the sprint state file. Do not
run against a sprint that is actively executing."

**Inputs (Zod):**

| Field | Type | Notes |
|-------|------|-------|
| `name` | `z.string()` | Project name/slug. Same as `run_sprint`/`resume_sprint`. |
| `sprint` | `z.number().int().positive()` | Sprint number. Same validation as the other two tools. |
| `confirm` | `z.boolean().optional().default(false)` | Confirmation flag (Open Question 2). Required only to force-reset a `complete` sprint (AC 7). Ignored for all other statuses. |

**Confirmation shape & guard scope (Open Question 2 — resolved):** a boolean
`confirm` flag, guarding **only** `complete`. `paused` is *not* guarded: it is a normal
recoverable checkpoint (resume territory), and clearing it destroys no shipped record.
`escalated` / `failed` / `in-progress` are never guarded — freeing them is the feature's
purpose.

**Output object (from `resetSprintTool`, mapped to MCP `content[]` in `index.ts`):**

```jsonc
// success — state cleared
{
  "status": "success",
  "project": "raptor-agentic-team",
  "sprint": 16,
  "priorStatus": "in-progress",          // the status that was cleared
  "summary": "4/9 steps complete, status 'in-progress'",
  "message": "Cleared sprint 16 state (was 'in-progress').",
  "nextAction": "run_sprint raptor-agentic-team 16"
}

// success — no-op (no state file)
{
  "status": "success",
  "project": "raptor-agentic-team",
  "sprint": 99,
  "priorStatus": "none",
  "message": "No sprint state found for sprint 99 — nothing to reset.",
  "nextAction": "run_sprint raptor-agentic-team 99"
}

// error — complete guard tripped
{
  "status": "error",
  "project": "raptor-agentic-team",
  "sprint": 14,
  "priorStatus": "complete",
  "message": "Sprint 14 is 'complete' (shipped). Re-run reset_sprint with confirm=true to force-discard its orchestration state. Committed artifacts, PR, and summary are unaffected."
}

// error — resolution / FS failure
{ "status": "error", "message": "Project 'nope' not found." }
{ "status": "error", "message": "Failed to clear sprint state for sprint 16: EACCES: permission denied, unlink '...'" }
```

The `index.ts` handler mirrors the existing two: push `message` (and any summary text) into
`content[]` as `type: "text"`. The tool function **returns** every failure as
`{status:"error"}`; it never throws to the transport (AC 1, 3, 10).

## Non-Functional Requirements

| # | Category | Requirement |
|---|----------|-------------|
| NFR-1 | **Performance** | A reset is O(1): one `existsSync` + one `readFileSync` (prior status) + one `rmSync`. No subprocess, no git, no network. Target < 10 ms wall-clock; no perceptible latency at the MCP boundary. |
| NFR-2 | **Reliability / idempotency** | Calling `reset_sprint` twice is safe: the second call finds no file and returns the informative success no-op (AC 6). The tool never throws to the transport (AC 1). |
| NFR-3 | **Truthfulness** | A `{status:"success"}` is returned **only** when the state was genuinely absent or genuinely removed. Any FS failure (EPERM/EACCES/EBUSY) surfaces as `{status:"error"}` with the underlying reason (AC 10). No swallowed failure. |
| NFR-4 | **Safety / scope containment** | Reset mutates **exactly one path**: `~/.raptor/{slug}/sprint-{N}.json`, resolved only through `state.ts`. It never touches git branches/PRs, committed artifacts, `docs/sprints/` summaries, `docs/backlog.md`, or `~/.raptor/projects.json` (AC 8). The `complete` guard protects shipped records from accidental wipe (AC 7). |
| NFR-5 | **Backward compatibility** | Additive only. No change to `SprintState`, `loadSprintState`, `saveSprintState`, `createInitialState`, `resumeSprint`, or `runSprintFromStep`. Existing six tools and all existing state files behave identically. Raptor now exposes seven tools. |
| NFR-6 | **Isolation from resume** | No shared or forked control flow with `resumeSprint`'s re-attempt path (AC 11). Reset does not import or call `resumeSprint`/`runSprintFromStep`. The two cannot double-implement or drift on step re-entry because reset implements none. |
| NFR-7 | **Input safety** | `name` is resolved through `registry.findProject` (not used as a raw path segment beyond the existing `sprintStatePath` join, identical to every other tool); `sprint` is a validated positive integer. No new path-traversal surface beyond what `run_sprint`/`resume_sprint` already expose. |
| NFR-8 | **Concurrency (Open Question 5 — resolved: no lock)** | The tool makes **no** attempt to detect a concurrently-running orchestrator. Resetting a live in-flight sprint is undefined and is the user's responsibility; the tool description states this expectation. No file locking is introduced this sprint. |

## Technology Choices

*All choices reuse the existing stack — **no new dependencies, no new tech to adopt.***

| Concern | Choice | Notes |
|---------|--------|-------|
| Tool registration | `@modelcontextprotocol/sdk` `server.tool(...)` | Identical pattern to the existing six tools in `src/index.ts`. |
| Input validation | **Zod** (`z.string()`, `z.number().int().positive()`, `z.boolean().optional().default(false)`) | Matches `run_sprint`/`resume_sprint` exactly. |
| State read | `loadSprintState` (existing, exported) | Reused to obtain prior status; returns `null` when absent → drives the no-op path. |
| State delete | `fs.rmSync` inside a new `deleteSprintState` helper in `state.ts` | Node built-in, synchronous — matches the synchronous FS style already used by `loadSprintState`/`saveSprintState`. Path resolution stays encapsulated. |
| Project resolution | `ctx.registry.findProject` (existing) | Same resolution + error parity as the other tools. |
| Result → transport mapping | Plain object → `content[]` text blocks in `index.ts` | Same shape mapping as `run_sprint`/`resume_sprint`. |
| Tests | **jest / ts-jest** — colocated unit (`tools.test.ts`) + `tests/integration/reset-sprint-tool.integration.test.ts` + BDD `tests/bdd/reset-sprint-tool.feature` | Production-seam tests drive the real `resetSprintTool` against a real temp `~/.raptor` state file (AC 12). |

**No new technology requires user approval** — this design is entirely additive within the
approved stack (TypeScript / Node.js / `@modelcontextprotocol/sdk` / Zod / `simple-git` /
jest). The only decision points requiring the user/PO's awareness are the three resolved
open questions below, all of which stay inside existing patterns.

## Constraints & Patterns

- **Additive-only, backward-compatible.** No edits to `SprintState`, the existing tools, or
  the runner/resume paths. The new state helper is purely additive; existing state files
  load and run unchanged (NFR-5).
- **Delete, don't rewrite (OQ1).** Reset `fs.rmSync`-deletes the state file, returning the
  sprint to its pre-first-run condition. `createInitialState` is **not** invoked by reset.
- **Path resolution stays in `state.ts`.** The tool never constructs
  `~/.raptor/{slug}/sprint-{N}.json` itself; `sprintStatePath` remains private and the tool
  goes through `loadSprintState` + `deleteSprintState`.
- **Guard `complete` only (OQ2).** A boolean `confirm` gate protects only the `complete`
  status. All wedged/in-flight statuses (`escalated`, `failed`, `in-progress`, `paused`)
  reset freely — that is the whole point.
- **Errors returned, never thrown.** Every failure path returns `{status:"error"}` with a
  human- and driver-readable message. `deleteSprintState` may throw an FS error; the tool
  wraps the delete in try/catch and converts it (AC 10, NFR-3).
- **No feedback, no re-run, no shared flow with resume (AC 11).** Reset clears state and
  returns; it never imports `resumeSprint` or calls `runSprintFromStep`.
- **No concurrency lock (OQ5).** Documented as user responsibility; no live-run detection.
- **Fire-and-forget audit (OQ4).** No reset log line is written to `~/.raptor` this sprint;
  the response carries the prior status + a one-line completed-step summary (OQ3) for
  post-mortem readability, which is sufficient.
- **Tests hit the production seam (AC 12).** Regression tests exercise the real
  `resetSprintTool` against a real temp `~/.raptor` directory (env-overridden `HOME` /
  `os.homedir`), asserting: (a) escalated/failed/`in-progress` state is cleared and a
  follow-up `run_sprint` would start at step 1; (b) no-state → success no-op; (c) `complete`
  refused without `confirm`, cleared with it; (d) unknown-project and missing-dir error
  parity. Each constraint-guarding test carries a **RED-verification note** — trivially RED
  today because `reset_sprint` does not exist and the `in-progress` case is un-resumable.

### Open Questions — resolved by the Architect

1. **Delete vs. rewrite-to-initial** → **Delete** (`fs.rmSync`). Byte-identical to the
   manual `rm`; no coupling to `createInitialState`'s signature. (§Overview)
2. **Confirmation shape & guard scope** → boolean **`confirm`** flag guarding **only
   `complete`**. `paused` unguarded. (§API Contracts)
3. **Auditability of discarded state** → response includes **prior status + one-line
   completed-step summary**; no full progress-table dump. (§Data Model)
4. **Reset audit trail** → **none this sprint** (fire-and-forget accepted). (§Constraints)
5. **Concurrent-run detection** → **no lock**; documented as user responsibility. (NFR-8)
