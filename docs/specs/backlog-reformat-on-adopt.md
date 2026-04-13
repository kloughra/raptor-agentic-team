# Feature Spec: backlog-reformat-on-adopt

## Problem
When adopting an existing repo with `adopt_project`, if the repo already has a backlog file, Raptor either skips it (if at `docs/backlog.md`) or ignores it (if elsewhere). Users lose their existing backlog items or have to manually reformat them into Raptor's canonical format. Additionally, backlog files may use non-standard casing (`BACKLOG.md`, `BACKLOG.MD`) which Raptor doesn't detect.

## Solution
Enhance `adopt_project` to detect existing backlog files case-insensitively, read their contents, and reformat them into Raptor's canonical backlog format at `docs/backlog.md` — preserving every item without data loss.

## User Stories
1. As a **user adopting an existing repo**, I want my existing backlog items preserved and reformatted into Raptor format so I don't lose any planned work.
2. As a **user with a BACKLOG.md (uppercase)**, I want Raptor to find and process it regardless of filename casing.
3. As a **PO agent**, I want the reformatted backlog to have proper Raptor sections so I can immediately start sprint planning.

## Acceptance Criteria
- [ ] Detect backlog files case-insensitively: `backlog.md`, `BACKLOG.md`, `BACKLOG.MD`, `Backlog.md`, or any casing variant
- [ ] Search in `docs/` directory first, then project root
- [ ] Reformat detected backlog into Raptor canonical format with sections: `## Sprint N — Planned`, `## Ready`, `## Inbox`, `## Done`
- [ ] Map common freeform section headers to Raptor sections:
  - "In Progress" / "Current" / "Active" / "WIP" / "Doing" → Sprint items
  - "Up Next" / "Ready" / "Prioritized" / "Next Sprint" / "Planned" → Ready
  - "Ideas" / "Inbox" / "Icebox" / "Someday" / "Future" / "Backlog Items" → Inbox
  - "Done" / "Completed" / "Finished" / "Shipped" / "Released" / "Closed" → Done
- [ ] Items with `[x]` checkbox (checked) are always categorized as Done regardless of section
- [ ] Items without any section context default to Inbox (safe default — nothing is lost)
- [ ] Preserve sprint numbers if the original backlog references them (e.g., "## Sprint 3")
- [ ] All item text preserved verbatim — no truncation, no summarization, no reformatting of the item itself
- [ ] Non-list content (paragraphs, notes) preserved in an HTML comment block in the Inbox section
- [ ] If `docs/backlog.md` already exists in Raptor format, reformat it in place (idempotent — Raptor format in → Raptor format out)
- [ ] If no backlog file found anywhere, fall back to generating a fresh Raptor backlog (existing behavior)
- [ ] Feature ideas passed via `featureIdeas` parameter are appended to Inbox during reformat

## Edge Cases
- Backlog file exists in both root and docs/ → prefer docs/ (closer to Raptor convention)
- Empty backlog file → generate fresh Raptor backlog
- Backlog with only headings, no items → generate sections with no items
- Backlog with nested lists (sub-items) → flatten to top-level items
- Backlog with numbered lists (`1.` instead of `-`) → treat as list items

## Out of Scope
- Merging multiple backlog files (if both root and docs/ have one, use docs/ only)
- Preserving original backlog file after reformat (it's replaced at `docs/backlog.md`)
- Automatic priority ordering of reformatted items
