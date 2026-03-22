# Raptor

An MCP server that orchestrates autonomous agentic dev teams. Tell Claude "start a new project" and Raptor spins up a full BDD/TDD development team — Product Owner, QA Engineer, Architect, and Software Engineers — that works through structured sprints to deliver tested, committed code.

Raptor acts as a command center for a human engineer who wants to manage multiple projects simultaneously. Each project gets its own repo, its own team, and its own sprint cadence — all following a shared process defined in [TEAM.md](./TEAM.md).

## How It Works

```
You: "Start a new project — it's a recipe sharing app"

Raptor:
  → Creates a new repo with full project scaffold
  → Stamps TEAM.md (the team playbook) into the repo
  → Initializes the backlog with your feature ideas
  → (Sprint 2+) Spins up agents in each role to begin Sprint 1
```

### MCP Tools

| Tool | Description |
|---|---|
| `bootstrap_project` | Create a new project repo with scaffold, TEAM.md, and backlog |
| `list_projects` | List all projects Raptor is managing |
| `get_project_status` | Check sprint progress, backlog state, and blockers for a project |

## The Agentic Team

Raptor manages teams that follow a structured BDD/TDD workflow defined in [TEAM.md](./TEAM.md):

| Role | Responsibility |
|---|---|
| **Product Owner** | Translates requirements into specs, manages the backlog, gates the demo |
| **QA Engineer** | Writes BDD, integration, performance, and Playwright E2E tests before code is written |
| **Architect** | Owns technical design, defines NFRs, reviews PRs for architectural compliance |
| **Software Engineer(s)** | Implements features TDD-style, commits code, opens PRs |

Each sprint produces a demoable, tested, git-committed increment. The full process — including handoff protocols, failure modes, and a Definition of Done — is in [TEAM.md](./TEAM.md).

## Tech Stack

| Component | Choice |
|---|---|
| Language | TypeScript |
| Runtime | Node.js |
| MCP SDK | `@modelcontextprotocol/sdk` |
| Git operations | `simple-git` |
| Transport | stdio (local) |
| Storage | JSON files (`~/.raptor/`) |

See [ADR-001](./docs/adr/ADR-001-technology-stack.md) for rationale.

## Setup

### Prerequisites

- Node.js v20+
- npm

### Install & Build

```bash
cd raptor/
npm install
npm run build
```

### Configure Claude Code

Add Raptor to your Claude Code MCP settings (`~/.claude/settings.json` or project-level `.claude/settings.json`):

```json
{
  "mcpServers": {
    "raptor": {
      "command": "node",
      "args": ["/absolute/path/to/raptor/dist/src/index.js"]
    }
  }
}
```

### Configuration (optional)

Raptor uses `~/.raptor/` for its config and project registry. You can customize the base directory where new projects are created:

```bash
mkdir -p ~/.raptor
echo '{ "projectsBaseDir": "~/projects" }' > ~/.raptor/config.json
```

If no config file exists, Raptor defaults to `~/projects`.

### Run Tests

```bash
npm test                  # All tests (unit + integration)
npm run test:unit         # Unit tests only
npm run test:integration  # Integration tests only
```

## Project Structure

```
raptor/
├── src/
│   ├── index.ts            # MCP server entry point (stdio transport)
│   ├── tools.ts            # bootstrap_project, list_projects, get_project_status
│   ├── registry.ts         # Read/write ~/.raptor/projects.json
│   ├── config.ts           # Read ~/.raptor/config.json
│   ├── template.ts         # Bundled TEAM.md + scaffold directory map
│   ├── backlog-parser.ts   # Parse backlog.md for sprint/section data
│   └── git-parser.ts       # Parse git log for [BLOCKER]/[ESCALATE] commits
├── template/
│   └── TEAM.md             # Canonical TEAM.md template (bundled)
├── docs/
│   ├── specs/              # Feature specifications
│   ├── architecture/       # Architecture design documents
│   ├── adr/                # Architecture Decision Records
│   ├── demos/              # Sprint demo notes
│   └── backlog.md          # Product backlog
├── tests/
│   ├── bdd/                # BDD scenarios (Gherkin)
│   └── integration/        # Integration tests (Jest)
├── TEAM.md                 # Team process definition
├── package.json
└── tsconfig.json
```

## Current Status

**Sprint 1 — Implementation Complete**

Core MCP server with `bootstrap_project`, `list_projects`, and `get_project_status` tools. 85 tests passing (unit + integration).

See [docs/backlog.md](./docs/backlog.md) for full backlog.

## Roadmap

- **Sprint 1**: Core MCP server — bootstrap projects, track status
- **Sprint 2**: Agent orchestration — spin up agents in roles, manage handoffs
- **Sprint 3+**: Dinosaur-themed agent names, remote hosting, GitHub integration, Discord communication

## Documentation

| Document | Description |
|---|---|
| [TEAM.md](./TEAM.md) | The complete agentic team process — roles, workflow, conventions, templates |
| [Feature Spec](./docs/specs/mcp-project-bootstrap.md) | Sprint 1 feature specification |
| [Architecture](./docs/architecture/mcp-project-bootstrap.md) | Sprint 1 architecture design with API contracts |
| [ADR-001](./docs/adr/ADR-001-technology-stack.md) | Technology stack decision record |
| [Backlog](./docs/backlog.md) | Product backlog with prioritized items |
