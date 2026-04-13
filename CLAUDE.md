# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Raptor

Raptor is an MCP server (stdio transport) for orchestrating agentic BDD/TDD dev teams. It manages a multi-project command center with team roles (Product Owner, QA Engineer, Architect, Software Engineers). Built with TypeScript, Node.js, and the `@modelcontextprotocol/sdk`.

**This project dogfoods its own methodology** — Raptor is built using the same agentic dev team process it orchestrates. The team process is defined in [TEAM.md](./TEAM.md), which serves as both the product's bundled template and the development process for this repo.

## Sprint Methodology

Development follows the structured BDD/TDD sprint workflow defined in TEAM.md. Key points:

- **Roles**: Product Owner (specs, backlog, acceptance), QA Engineer (tests before code), Architect (design, NFRs, PR review), Software Engineer(s) (TDD implementation)
- **Sprint workflow** (sequential with noted parallelism):
  1. PO authors spec → 2. Architect designs → 3. QA writes tests → 4. PO reviews tests → 5. Engineers implement TDD → 6. PR → 7. Architect + QA review (parallel) → 8. Demo → 9. Feedback
- **Branching**: `sprint-{N}/{feature-slug}` for features, `hotfix/{description}` for hotfixes. **All sprint commits (including PO backlog prep, specs, architecture) go on the sprint branch — never commit to `main` directly.**
- **Handoffs are git commits**: `[HANDOFF] From -> To: artifact for feature`
- **Definition of Done**: all tests pass, PR with test evidence, peer review, PO acceptance, demo conducted
- **Circuit breaker**: if an action fails 3 times, stop and escalate to user with `[ESCALATE]`

Artifacts follow strict conventions — feature slug is the canonical ID used across specs (`docs/specs/{slug}.md`), architecture (`docs/architecture/{slug}.md`), tests (`tests/bdd/{slug}.feature`), etc. See TEAM.md for templates and the full artifact directory map.

## ⛔ No Code Without Process

**CRITICAL: Never write, modify, or delete code outside of a tracked workflow.** This applies to ALL code changes, no matter how small or urgent.

Before writing ANY code, verify:
1. **Am I on a sprint or hotfix branch?** If on `main`, STOP. Create a branch first.
2. **Is this change tracked?** It must be either a sprint backlog item or a hotfix with a clear scope.
3. **Have I read the required artifacts?** Spec, architecture, tests — whatever applies to the change.

**Allowed workflows:**
- **Sprint workflow** (full SDLC): PO spec → Architect design → QA tests → Engineer implement → PR → Review → Demo → Merge. Use for all feature work.
- **Hotfix workflow** (lightweight SDLC): Create `hotfix/{description}` branch → implement + write tests → PR → user approval → merge. Use for bugs, small enhancements, and process fixes.

**Never acceptable:**
- Writing code directly on `main`
- Implementing a feature without at minimum: branch, tests, PR
- Skipping the process because a change "seems small" or "is urgent"
- Starting to code before confirming the workflow path with the user

If the user asks for a quick change, respond: "I'll put this through a hotfix workflow — branch, implement, test, PR. Sound good?" Do not start coding until the workflow is confirmed.

## Build & Test Commands

```bash
npm run build          # Compile TypeScript → dist/
npm test               # Run all tests (unit + integration)
npm run test:unit      # Unit tests only (src/**/*.test.ts)
npm run test:integration  # Integration tests only (tests/integration/)
```

To run a single test file:
```bash
npx jest src/tools.test.ts
npx jest --testPathPattern="backlog-parser"
```

There is no separate lint or format command configured.

## Architecture

The MCP server exposes 6 tools over stdio: `bootstrap_project`, `adopt_project`, `list_projects`, `get_project_status`, `run_sprint`, `resume_sprint`.

| Module | Role |
|--------|------|
| `src/index.ts` | Entry point; registers tools, starts stdio transport |
| `src/tools.ts` | Tool implementations; each returns `{status, ...}` |
| `src/registry.ts` | CRUD for project registry (`~/.raptor/projects.json`) |
| `src/config.ts` | Loads `~/.raptor/config.json`; resolves `~` paths |
| `src/template.ts` | Bundled TEAM.md template + scaffold directory definitions |
| `src/backlog-parser.ts` | Parses sprint/backlog sections from `docs/backlog.md` |
| `src/git-parser.ts` | Extracts `[BLOCKER]` and `[ESCALATE]` entries from git log |

All storage is JSON files (no database). Git operations use `simple-git`. Input validation uses Zod.

The bundled TEAM.md template lives at `template/TEAM.md` and is copied into `dist/` at build time — see `BUNDLED_TEMPLATE_PATH` in `template.ts`.

## Conventions

**Commit messages**: `[ROLE] verb: description` — e.g., `[ENGINEER] add: location parameter to bootstrap_project tool`

**Project names**: lowercase, hyphen-separated, matching `^[a-z][a-z0-9-]*$`

**Backlog format** (`docs/backlog.md`): sections are `## Sprint N`, `## Ready`, `## Inbox`, `## Done` with `- [ ]` / `- [x]` items.

**Git markers**: `[BLOCKER] Role: desc -- blocked on Role` and `[ESCALATE] Role: desc` in commit messages for status tracking.

## Running the MCP Server

```bash
npm run build && node dist/src/index.js
```

The `.mcp.json` at root configures Claude Code to use this as a local MCP server.
