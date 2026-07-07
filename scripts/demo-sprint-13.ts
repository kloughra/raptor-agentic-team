/**
 * Sprint 13 demo — retro-improvements-not-applied (demo-only script, step 8)
 * Reproduces the Sprint 10/12 incident shape (AC 9 fixture):
 * an adopted proposal whose free-text Section is a plausible-but-inexact
 * heading reference, applied against the real bundled template/TEAM.md.
 */
import * as fs from "fs";
import * as path from "path";
import {
  applyImprovements,
  updateRetroDocWithAppliedChanges,
  FALLBACK_SECTION_HEADING,
  RetroProposal,
} from "../src/orchestrator/retro";

const teamMd = fs.readFileSync(
  path.join(__dirname, "..", "template", "TEAM.md"),
  "utf-8"
);

const proposals: RetroProposal[] = [
  {
    role: "PO",
    type: "process",
    section: "Product Owner responsibilities", // ← inexact: real heading is "### Product Owner (PO)"
    text: "Capture [FOLLOW-UP] items from demo feedback into the backlog Inbox within 24h.",
  } as RetroProposal,
  {
    role: "QA",
    type: "process",
    section: "QA Engineer", // ← matches "### QA Engineer" after normalization
    text: "Record flaky-test candidates in the sprint retro doc.",
  } as RetroProposal,
];

console.log("=== DEMO 1: the Sprint 10/12 incident shape, post-fix ===\n");
const result = applyImprovements(teamMd, proposals, 13);

console.log(`changed: ${result.changed}`);
console.log(`outcomes (${result.outcomes.length} — one per proposal, AC 1 invariant):`);
for (const o of result.outcomes) {
  console.log(
    `  [${o.placement}] ${o.role} → target "${o.section}"` +
      (o.placedAt ? ` → placed at "${o.placedAt}"` : "") +
      (o.reason ? ` (reason: ${o.reason})` : "")
  );
}

console.log(`\nFallback section present in output: ${result.content.includes(FALLBACK_SECTION_HEADING)}`);
const fbIdx = result.content.indexOf(FALLBACK_SECTION_HEADING);
if (fbIdx >= 0) {
  console.log("\n--- fallback section excerpt ---");
  console.log(result.content.slice(fbIdx, fbIdx + 450));
  console.log("--- end excerpt ---");
}

console.log("\n=== DEMO 2: idempotency — re-run against already-applied content ===\n");
const rerun = applyImprovements(result.content, proposals, 13);
console.log(`changed: ${rerun.changed}`);
for (const o of rerun.outcomes) {
  console.log(`  [${o.placement}] ${o.role} → "${o.section}"`);
}

console.log("\n=== DEMO 3: retro doc 'Applied Changes' stub gets filled (AC 3) ===\n");
const retroDocStub = `# Sprint 13 Retro\n\n## Proposals\n(...)\n\n## Applied Changes\n\n(None yet)\n`;
const updatedDoc = updateRetroDocWithAppliedChanges(retroDocStub, result.outcomes);
const acIdx = updatedDoc.indexOf("## Applied Changes");
console.log(updatedDoc.slice(acIdx));

console.log("=== DEMO 4: fence-aware matching — heading inside a code block does NOT match ===\n");
const fenced =
  "# Team\n\n### Real Section\n\nBody.\n\n```markdown\n### Trap Section\n(template example inside a fence)\n```\n";
const fencedResult = applyImprovements(
  fenced,
  [{ role: "ARCHITECT", type: "process", section: "Trap Section", text: "Should NOT land inside the fence." } as RetroProposal],
  13
);
const o = fencedResult.outcomes[0];
console.log(`  [${o.placement}] target "Trap Section" → ${o.placedAt ? `placed at "${o.placedAt}"` : "no heading match → fallback"}`);
