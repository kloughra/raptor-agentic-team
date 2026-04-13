# Feature Spec: codebase-aware-agent-context

## Problem
Agents in Sprint 2+ operate with only high-level sprint summaries from prior sprints. They lack awareness of the actual codebase — file structure, module boundaries, existing patterns, and implementation details. This leads to:
- Agents proposing designs that duplicate existing modules
- Generated code that doesn't follow established patterns
- Specs that miss integration points with existing features
- Wasted agent cycles rediscovering what already exists

## Solution
Build a codebase snapshot system that captures the current state of the project and injects it into agent context at sprint start. The snapshot includes directory tree, key file excerpts, module summaries, and dependency graph — giving every agent role a shared understanding of what's already been built.

## User Stories
1. As a **PO agent**, I want to see what modules exist so I write specs that reference real code paths.
2. As an **Architect agent**, I want to see existing patterns (error handling, module structure, exports) so my designs are consistent.
3. As a **QA agent**, I want to know existing test patterns so my new tests follow the same conventions.
4. As an **Engineer agent**, I want to see the actual source files I'll modify so I can plan integration points.
5. As a **user**, I want codebase context to be automatic — no manual config needed.

## Acceptance Criteria
- [ ] At sprint start, a codebase snapshot is generated from the project's source tree
- [ ] Snapshot includes: directory tree, key source file excerpts (capped), module export summaries, dependency list
- [ ] Snapshot is injected into every agent's system prompt as a `## Codebase Context` section
- [ ] Snapshot respects a configurable size cap (default 30KB) to avoid prompt bloat
- [ ] Files in .gitignore, node_modules, dist, and binary files are excluded
- [ ] Sprint summary context (from Sprint 4) is preserved alongside codebase context — they complement, not replace
- [ ] Codebase snapshot is regenerated at each step (not cached from sprint start) so agents see changes from prior steps

## Out of Scope
- Full AST parsing or semantic analysis — we use text excerpts
- Codebase context for the very first sprint (nothing exists yet)
- User-editable snapshot templates (future feature)
