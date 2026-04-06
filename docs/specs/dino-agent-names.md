---
slug: dino-agent-names
status: draft
sprint: 5
---
# Dinosaur Agent Names

## User Story
As a Raptor user, I want each agent role to have a dinosaur-themed name and personality, so that the sprint output is more engaging, identifiable, and fun to follow.

## Acceptance Criteria
1. Each role has a canonical dinosaur name:
   - PO → **Pteranodon** ("Petra") — soars above, sees the big picture
   - Architect → **Ankylosaurus** ("Anky") — armored, builds solid structures
   - QA → **Velociraptor** ("Vex") — sharp-eyed, catches everything
   - Engineer → **Triceratops** ("Trix") — charges through implementation
   - Team (demo) → **Brachiosaurus** ("Brax") — towers over the whole picture
2. Dinosaur names appear in:
   - Progress table role column (e.g., "🦕 Petra (PO)")
   - Agent system prompts (role introduction includes dinosaur identity)
   - Handoff commits (e.g., `[HANDOFF] Petra (PO) -> Anky (Architect): spec for feature-slug`)
   - Checkpoint prompts (e.g., "Petra is requesting your review...")
3. A `DINO_NAMES` config map is defined in a new `src/orchestrator/dino.ts` module
4. Names can be overridden via project config (`~/.raptor/config.json` → `dinoNames` field) for customization
5. Existing role identifiers (`po`, `architect`, etc.) remain the canonical keys — dino names are display-only

## Edge Cases
- Custom dino names in config are missing some roles → fall back to defaults for unspecified roles
- Config has invalid role keys → ignore them, use defaults

## Out of Scope
- Per-sprint or per-feature name changes
- User-facing avatar images
- Dinosaur facts or trivia in output (tempting, but out of scope)

## Open Questions
- None
