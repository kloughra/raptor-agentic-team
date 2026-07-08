import { stripSuppressedLines } from "./orchestrator/blocker-marker";

export interface BlockerEntry {
  role: string;
  description: string;
  blockedOn: string;
  commit: string;
  date: string;
}

export interface EscalationEntry {
  role: string;
  description: string;
  commit: string;
  date: string;
}

export interface GitLogEntry {
  hash: string;
  date: string;
  message: string;
}

export function parseBlockers(logEntries: GitLogEntry[]): BlockerEntry[] {
  const blockers: BlockerEntry[] = [];

  for (const entry of logEntries) {
    // AC 6: line-anchor the grammar over the suppressed (fence/blockquote-free)
    // message body so a marker quoted in a fenced/quoted commit body — or the
    // embedded mid-line `[BLOCKER]` inside the orchestrator's own `[ESCALATE]
    // … agent raised [BLOCKER]: …` commit — is not mis-read as a blocker.
    const match = stripSuppressedLines(entry.message).match(
      /^\s*\[BLOCKER\]\s+(\w+):\s+(.+?)\s*--\s*blocked\s+on\s+(\w+)/im
    );
    if (match) {
      blockers.push({
        role: match[1],
        description: match[2].trim(),
        blockedOn: match[3],
        commit: entry.hash,
        date: entry.date,
      });
    }
  }

  return blockers;
}

export function parseEscalations(logEntries: GitLogEntry[]): EscalationEntry[] {
  const escalations: EscalationEntry[] = [];

  for (const entry of logEntries) {
    // AC 6: line-anchor over the suppressed message body (same rationale as
    // parseBlockers) — a marker quoted in a fenced/blockquoted body is ignored.
    const match = stripSuppressedLines(entry.message).match(
      /^\s*\[ESCALATE\]\s+(\w+):\s+(.+)/im
    );
    if (match) {
      escalations.push({
        role: match[1],
        description: match[2].trim(),
        commit: entry.hash,
        date: entry.date,
      });
    }
  }

  return escalations;
}
