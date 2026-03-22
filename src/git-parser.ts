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
    const match = entry.message.match(
      /\[BLOCKER\]\s+(\w+):\s+(.+?)\s*--\s*blocked\s+on\s+(\w+)/i
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
    const match = entry.message.match(
      /\[ESCALATE\]\s+(\w+):\s+(.+)/i
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
