import * as fs from "fs";
import * as path from "path";

/**
 * Resolve the actual path to the backlog file, case-insensitively.
 * Searches docs/ first, then project root, for any casing of "backlog.md".
 * Returns the real path on disk (preserving actual casing) or null if not found.
 */
export function resolveBacklogPath(projectPath: string): string | null {
  const candidateDirs = [
    path.join(projectPath, "docs"),
    projectPath,
  ];

  for (const dir of candidateDirs) {
    if (!fs.existsSync(dir)) continue;
    try {
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (file.toLowerCase() === "backlog.md") {
          return path.join(dir, file);
        }
      }
    } catch {
      // skip unreadable dirs
    }
  }

  return null;
}

export interface BacklogSections {
  inbox: { count: number; items: string[] };
  ready: { count: number; items: string[] };
  sprint: { count: number; items: string[] };
  done: { count: number; items: string[] };
}

export function parseSprintNumber(backlogContent: string): number {
  const match = backlogContent.match(
    /##\s+Sprint\s+(\d+)\s*[—–-]\s*In\s*Progress/i
  );
  if (match) {
    return parseInt(match[1], 10);
  }
  return 0;
}

export function parseBacklogSections(backlogContent: string): BacklogSections {
  const result: BacklogSections = {
    inbox: { count: 0, items: [] },
    ready: { count: 0, items: [] },
    sprint: { count: 0, items: [] },
    done: { count: 0, items: [] },
  };

  const lines = backlogContent.split("\n");
  let currentSection: keyof BacklogSections | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section headers
    if (/^##\s+Sprint\s+\d+\s*[—–-]\s*In\s*Progress/i.test(trimmed)) {
      currentSection = "sprint";
      continue;
    }
    if (/^##\s+Ready/i.test(trimmed)) {
      currentSection = "ready";
      continue;
    }
    if (/^##\s+Inbox/i.test(trimmed)) {
      currentSection = "inbox";
      continue;
    }
    if (/^##\s+Done/i.test(trimmed)) {
      currentSection = "done";
      continue;
    }
    // Any other H2 resets the section
    if (/^##\s+/.test(trimmed)) {
      currentSection = null;
      continue;
    }

    // Parse list items in the current section
    if (currentSection && /^-\s+/.test(trimmed)) {
      const itemText = trimmed.replace(/^-\s+(\[[ x]\]\s+)?/, "").trim();
      if (itemText.length > 0) {
        result[currentSection].items.push(itemText);
        result[currentSection].count++;
      }
    }
  }

  return result;
}
