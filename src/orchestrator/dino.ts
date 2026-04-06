import { Role } from "./workflow";

export interface DinoIdentity {
  role: Role;
  species: string;
  nickname: string;
  emoji: string;
  tagline: string;
}

export const DEFAULT_DINO_NAMES: Record<Role, DinoIdentity> = {
  po: { role: "po", species: "Pteranodon", nickname: "Petra", emoji: "🦅", tagline: "soars above, sees the big picture" },
  architect: { role: "architect", species: "Ankylosaurus", nickname: "Anky", emoji: "🛡️", tagline: "armored, builds solid structures" },
  qa: { role: "qa", species: "Velociraptor", nickname: "Vex", emoji: "🔍", tagline: "sharp-eyed, catches everything" },
  engineer: { role: "engineer", species: "Triceratops", nickname: "Trix", emoji: "🔨", tagline: "charges through implementation" },
  team: { role: "team", species: "Brachiosaurus", nickname: "Brax", emoji: "🦕", tagline: "towers over the whole picture" },
};

/**
 * Resolve dino names by merging config overrides with defaults.
 * Invalid role keys in overrides are silently ignored.
 */
export function resolveDinoNames(
  configOverrides?: Partial<Record<string, Partial<DinoIdentity>>>
): Record<Role, DinoIdentity> {
  const names: Record<Role, DinoIdentity> = {
    po: { ...DEFAULT_DINO_NAMES.po },
    architect: { ...DEFAULT_DINO_NAMES.architect },
    qa: { ...DEFAULT_DINO_NAMES.qa },
    engineer: { ...DEFAULT_DINO_NAMES.engineer },
    team: { ...DEFAULT_DINO_NAMES.team },
  };

  if (!configOverrides) return names;

  const validRoles: Role[] = ["po", "architect", "qa", "engineer", "team"];
  for (const [key, overrides] of Object.entries(configOverrides)) {
    if (!validRoles.includes(key as Role)) continue;
    if (!overrides) continue;
    const role = key as Role;
    names[role] = {
      ...names[role],
      ...overrides,
      role, // ensure role key is never overridden
    };
  }

  return names;
}

const ROLE_DISPLAY_MAP: Record<string, string> = {
  po: "PO",
  architect: "Architect",
  qa: "QA",
  engineer: "Engineer",
  team: "Team",
};

function capitalizeRole(role: string): string {
  return ROLE_DISPLAY_MAP[role] || role;
}

/**
 * Format a role for display in progress tables: "🦅 Petra (PO)"
 */
export function formatRoleDisplay(role: Role, names: Record<Role, DinoIdentity>): string {
  const dino = names[role];
  return `${dino.emoji} ${dino.nickname} (${capitalizeRole(role)})`;
}

/**
 * Format a role for handoff commits and messages: "Petra (PO)"
 */
export function formatHandoffRole(role: Role, names: Record<Role, DinoIdentity>): string {
  const dino = names[role];
  return `${dino.nickname} (${capitalizeRole(role)})`;
}

/**
 * Build an identity preamble for a role's system prompt.
 * Prepended to the existing role prompt.
 */
export function buildDinoIdentityPreamble(role: Role, names: Record<Role, DinoIdentity>): string {
  const dino = names[role];
  return `You are ${dino.nickname} the ${dino.species} — ${dino.tagline}.`;
}
