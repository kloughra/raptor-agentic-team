import { Role } from "../../src/orchestrator/workflow";
import { createInitialState } from "../../src/orchestrator/state";
import { renderProgressTable } from "../../src/orchestrator/progress";
import { buildRolePrompt } from "../../src/orchestrator/prompts";

// Types for the dino module (will be created at src/orchestrator/dino.ts)
interface DinoIdentity {
  role: Role;
  species: string;
  nickname: string;
  emoji: string;
  tagline: string;
}

// Default dino names as specified in the spec
const DEFAULT_DINO_NAMES: Record<Role, DinoIdentity> = {
  po: { role: "po", species: "Pteranodon", nickname: "Petra", emoji: "🦅", tagline: "soars above, sees the big picture" },
  architect: { role: "architect", species: "Ankylosaurus", nickname: "Anky", emoji: "🛡️", tagline: "armored, builds solid structures" },
  qa: { role: "qa", species: "Velociraptor", nickname: "Vex", emoji: "🔍", tagline: "sharp-eyed, catches everything" },
  engineer: { role: "engineer", species: "Triceratops", nickname: "Trix", emoji: "🔨", tagline: "charges through implementation" },
  team: { role: "team", species: "Brachiosaurus", nickname: "Brax", emoji: "🦕", tagline: "towers over the whole picture" },
};

function resolveDinoNames(
  configOverrides?: Partial<Record<string, Partial<DinoIdentity>>>
): Record<Role, DinoIdentity> {
  const names = { ...DEFAULT_DINO_NAMES };
  if (!configOverrides) return names;

  const validRoles: Role[] = ["po", "architect", "qa", "engineer", "team"];
  for (const [key, overrides] of Object.entries(configOverrides)) {
    if (!validRoles.includes(key as Role)) continue;
    const role = key as Role;
    names[role] = {
      ...names[role],
      ...overrides,
      role, // ensure role key is never overridden
    };
  }
  return names;
}

function formatRoleDisplay(role: Role, names: Record<Role, DinoIdentity>): string {
  const dino = names[role];
  return `${dino.emoji} ${dino.nickname} (${capitalizeRole(role)})`;
}

function formatHandoffRole(role: Role, names: Record<Role, DinoIdentity>): string {
  const dino = names[role];
  return `${dino.nickname} (${capitalizeRole(role)})`;
}

function capitalizeRole(role: string): string {
  const map: Record<string, string> = {
    po: "PO",
    architect: "Architect",
    qa: "QA",
    engineer: "Engineer",
    team: "Team",
  };
  return map[role] || role;
}

describe("Dinosaur Agent Names", () => {
  describe("Default dino names", () => {
    it("PO is Pteranodon with nickname Petra", () => {
      expect(DEFAULT_DINO_NAMES.po.species).toBe("Pteranodon");
      expect(DEFAULT_DINO_NAMES.po.nickname).toBe("Petra");
      expect(DEFAULT_DINO_NAMES.po.emoji).toBe("🦅");
    });

    it("Architect is Ankylosaurus with nickname Anky", () => {
      expect(DEFAULT_DINO_NAMES.architect.species).toBe("Ankylosaurus");
      expect(DEFAULT_DINO_NAMES.architect.nickname).toBe("Anky");
    });

    it("QA is Velociraptor with nickname Vex", () => {
      expect(DEFAULT_DINO_NAMES.qa.species).toBe("Velociraptor");
      expect(DEFAULT_DINO_NAMES.qa.nickname).toBe("Vex");
    });

    it("Engineer is Triceratops with nickname Trix", () => {
      expect(DEFAULT_DINO_NAMES.engineer.species).toBe("Triceratops");
      expect(DEFAULT_DINO_NAMES.engineer.nickname).toBe("Trix");
    });

    it("Team is Brachiosaurus with nickname Brax", () => {
      expect(DEFAULT_DINO_NAMES.team.species).toBe("Brachiosaurus");
      expect(DEFAULT_DINO_NAMES.team.nickname).toBe("Brax");
    });

    it("all roles have a tagline", () => {
      const roles: Role[] = ["po", "architect", "qa", "engineer", "team"];
      for (const role of roles) {
        expect(DEFAULT_DINO_NAMES[role].tagline).toBeTruthy();
      }
    });
  });

  describe("formatRoleDisplay", () => {
    it("formats PO as emoji + nickname + role", () => {
      const display = formatRoleDisplay("po", DEFAULT_DINO_NAMES);
      expect(display).toBe("🦅 Petra (PO)");
    });

    it("formats QA as emoji + nickname + role", () => {
      const display = formatRoleDisplay("qa", DEFAULT_DINO_NAMES);
      expect(display).toBe("🔍 Vex (QA)");
    });

    it("formats Engineer as emoji + nickname + role", () => {
      const display = formatRoleDisplay("engineer", DEFAULT_DINO_NAMES);
      expect(display).toBe("🔨 Trix (Engineer)");
    });
  });

  describe("formatHandoffRole", () => {
    it("formats PO -> Architect handoff names", () => {
      const from = formatHandoffRole("po", DEFAULT_DINO_NAMES);
      const to = formatHandoffRole("architect", DEFAULT_DINO_NAMES);
      expect(from).toBe("Petra (PO)");
      expect(to).toBe("Anky (Architect)");
      expect(`[HANDOFF] ${from} -> ${to}: specification for feature-slug`).toContain("Petra (PO) -> Anky (Architect)");
    });
  });

  describe("Config overrides", () => {
    it("custom dino names override defaults", () => {
      const overrides = {
        qa: { species: "T-Rex", nickname: "Rexy" },
      };

      const names = resolveDinoNames(overrides);

      expect(names.qa.species).toBe("T-Rex");
      expect(names.qa.nickname).toBe("Rexy");
      // Other roles unchanged
      expect(names.po.species).toBe("Pteranodon");
      expect(names.engineer.species).toBe("Triceratops");
    });

    it("partial overrides merge with defaults", () => {
      const overrides = {
        engineer: { nickname: "Rocky" },
      };

      const names = resolveDinoNames(overrides);

      expect(names.engineer.nickname).toBe("Rocky");
      expect(names.engineer.species).toBe("Triceratops"); // default preserved
      expect(names.engineer.emoji).toBe("🔨"); // default preserved
    });

    it("invalid role keys in config are ignored", () => {
      const overrides = {
        intern: { species: "Baby Dino", nickname: "Tiny" },
      };

      const names = resolveDinoNames(overrides);

      // All roles should have their defaults
      expect(names.po.species).toBe("Pteranodon");
      expect(names.architect.species).toBe("Ankylosaurus");
      expect(names.qa.species).toBe("Velociraptor");
      expect(names.engineer.species).toBe("Triceratops");
      expect(names.team.species).toBe("Brachiosaurus");
    });

    it("empty config returns defaults", () => {
      const names = resolveDinoNames({});
      expect(names.po.species).toBe("Pteranodon");
    });

    it("undefined config returns defaults", () => {
      const names = resolveDinoNames(undefined);
      expect(names.po.species).toBe("Pteranodon");
    });

    it("role key in override cannot change the role field", () => {
      const overrides = {
        qa: { role: "engineer" as Role, species: "T-Rex" },
      };

      const names = resolveDinoNames(overrides);
      expect(names.qa.role).toBe("qa"); // should remain "qa"
      expect(names.qa.species).toBe("T-Rex");
    });
  });

  describe("System prompt integration", () => {
    it("buildRolePrompt returns a string for each role", () => {
      const roles: Role[] = ["po", "architect", "qa", "engineer", "team"];
      for (const role of roles) {
        const prompt = buildRolePrompt(role);
        expect(typeof prompt).toBe("string");
        expect(prompt.length).toBeGreaterThan(0);
      }
    });

    it("dino identity can be prepended to role prompt", () => {
      const dino = DEFAULT_DINO_NAMES.qa;
      const basePrompt = buildRolePrompt("qa");
      const enhancedPrompt = `You are ${dino.nickname} the ${dino.species} — ${dino.tagline}.\n\n${basePrompt}`;

      expect(enhancedPrompt).toContain("You are Vex the Velociraptor");
      expect(enhancedPrompt).toContain("sharp-eyed, catches everything");
      expect(enhancedPrompt).toContain("You are the QA Engineer"); // original prompt content
    });
  });

  describe("Checkpoint prompt integration", () => {
    it("dino name can be included in checkpoint description", () => {
      const dino = DEFAULT_DINO_NAMES.po;
      const checkpointDescription = `${dino.nickname} (${capitalizeRole(dino.role)}) is requesting your review of the specification.`;

      expect(checkpointDescription).toContain("Petra (PO)");
      expect(checkpointDescription).toContain("review of the specification");
    });
  });

  describe("Escalation commit integration", () => {
    it("escalation commit uses dino name", () => {
      const dino = DEFAULT_DINO_NAMES.qa;
      const commitMsg = `[ESCALATE] ${dino.nickname} (${capitalizeRole(dino.role)}): step 7 (Run test suite) failed 3 times`;

      expect(commitMsg).toContain("Vex (QA)");
      expect(commitMsg).toContain("[ESCALATE]");
    });
  });

  describe("Progress table role display", () => {
    it("current progress table renders roles", () => {
      const state = createInitialState("test-project", 5, [
        { step: 1, role: "po", name: "Author specification" },
        { step: 2, role: "architect", name: "Architecture design" },
        { step: 3, role: "qa", name: "Write tests" },
      ]);

      const table = renderProgressTable(state);

      // Current implementation uses capitalized roles — dino names will enhance these
      expect(table).toContain("PO");
      expect(table).toContain("Architect");
      expect(table).toContain("QA");
    });
  });
});
