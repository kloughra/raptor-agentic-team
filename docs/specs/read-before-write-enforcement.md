# Feature Spec: read-before-write-enforcement

## Problem
Agents sometimes generate output without thoroughly reading their input artifacts. An Architect may write a design without fully digesting the PO spec. An Engineer may start coding without reading the architecture doc or test file. This leads to:
- Output that misses requirements from input artifacts
- Designs that don't address all spec acceptance criteria
- Code that doesn't match the architectural decisions
- Wasted retry cycles when reviewers catch the gaps

## Solution
Add a structured **discovery phase** before each agent's generation phase. The discovery phase explicitly lists which input artifacts the agent must read, injects them directly into the agent's task description, and adds a verification checklist the agent must acknowledge before proceeding to generation.

## User Stories
1. As a **user**, I want confidence that agents read all relevant inputs before producing outputs.
2. As a **QA agent**, I want the spec and architecture doc pre-loaded so I write tests that cover all acceptance criteria.
3. As an **Engineer agent**, I want the spec, architecture, and test files pre-loaded so my implementation addresses everything.
4. As a **reviewer**, I want to see which artifacts were consumed, so I can verify completeness.

## Acceptance Criteria
- [ ] Each workflow step has a defined set of required input artifacts (e.g., Engineer requires: spec, architecture doc, test file)
- [ ] Input artifacts are read from disk and injected into the agent's task description as `## Required Reading` sections
- [ ] If a required artifact is missing from disk, the step fails with a clear error (not silently skipped)
- [ ] The agent's task description includes a checklist: "Before generating output, confirm you have reviewed: [list]"
- [ ] Artifact injection is configurable — users can add custom required files per step via config
- [ ] The handoff commit message includes which artifacts were consumed (for audit trail)
- [ ] Works with both single-feature and multi-feature sprints (artifacts resolved per feature slug)

## Out of Scope
- Runtime verification that the agent actually "understood" the artifacts (we inject, not enforce comprehension)
- Automatic artifact generation if missing (that's a separate concern)
- Tracking which specific lines the agent referenced
