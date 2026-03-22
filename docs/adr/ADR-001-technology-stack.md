---
slug: technology-stack
status: user-approved
date: 2026-03-21
---

# ADR-001: Raptor Technology Stack

## Context

Raptor is a local MCP server that orchestrates agentic dev teams across multiple projects. Sprint 1 requires bootstrapping repos, tracking projects, and reporting status. The technology stack must support MCP tool registration, git operations, and local file management.

## Decision

| Component | Choice |
|---|---|
| Language | TypeScript |
| Runtime | Node.js |
| MCP SDK | `@modelcontextprotocol/sdk` |
| Git operations | `simple-git` |
| Package manager | npm |
| Transport | stdio (local) |
| Configuration | `~/.raptor/config.json` |
| Registry | `~/.raptor/projects.json` |
| Storage | JSON files (no database) |

## Rationale

- **TypeScript + MCP SDK**: The TypeScript SDK is the MCP reference implementation — most mature, best documented, and strong typing helps agents parse tool schemas reliably.
- **simple-git**: Clean wrapper around git CLI. Avoids shell-escaping issues. Covers init, add, commit, and log parsing.
- **stdio transport**: Standard for local MCP servers with Claude Code. No HTTP/port management. Leaves the door open for SSE transport when we go remote in future sprints.
- **JSON files over database**: A project registry and config file are sufficient for Sprint 1. No need for SQLite or anything heavier — we're tracking a handful of projects, not millions of records.
- **No HTTP framework**: stdio transport means no Express/Fastify needed.

## Consequences

- Local-only for Sprint 1. Multi-device will require switching to SSE transport and hosting the server (future ADR).
- JSON registry is simple but doesn't support concurrent writes. Acceptable for a single-user local server. Revisit if we go multi-device.
- TypeScript requires a build step (`tsc`), but this is standard and well-understood.
