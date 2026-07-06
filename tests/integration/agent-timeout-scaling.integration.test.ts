import {
  resolveStepTimeout,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  TimeoutConfig,
} from "../../src/orchestrator/timeouts";

/**
 * Asserts against the REAL production resolver (src/orchestrator/timeouts.ts).
 * This suite previously tested a local re-implementation of resolveStepTimeout,
 * which stayed green when production changed (the false-green anti-pattern
 * flagged in the Sprint 10 retro) — converted to production seams as part of
 * the Sprint 12 write-tests-timeout-bump commit.
 */
describe("Agent Timeout Scaling by Step Type", () => {
  describe("Built-in step defaults", () => {
    it("QA test generation gets 30 minutes (raised from 15 after sprint-11-write-tests-escalation)", () => {
      expect(resolveStepTimeout("Write tests")).toBe(30 * 60 * 1000);
    });

    it("Engineer implementation gets 10 minutes", () => {
      expect(resolveStepTimeout("Implement (TDD)")).toBe(600000);
    });

    it("Architecture design gets 7 minutes", () => {
      expect(resolveStepTimeout("Architecture design")).toBe(420000);
    });

    it("Other steps use 5 minute default", () => {
      expect(resolveStepTimeout("Open PR")).toBe(300000);
    });

    it("Demo uses 5 minute default", () => {
      expect(resolveStepTimeout("Demo")).toBe(300000);
    });

    it("Author specification uses 5 minute default", () => {
      expect(resolveStepTimeout("Author specification")).toBe(300000);
    });
  });

  describe("Config overrides", () => {
    it("config step override takes precedence over built-in", () => {
      const config: TimeoutConfig = {
        stepOverrides: { "Write tests": 1200000 },
      };
      expect(resolveStepTimeout("Write tests", config)).toBe(1200000);
    });

    it("config default overrides global fallback", () => {
      const config: TimeoutConfig = { default: 420000 };
      expect(resolveStepTimeout("Open PR", config)).toBe(420000);
    });

    it("config step override beats config default", () => {
      const config: TimeoutConfig = {
        default: 420000,
        stepOverrides: { "Write tests": 1200000 },
      };
      expect(resolveStepTimeout("Write tests", config)).toBe(1200000);
    });

    it("config default applies before built-in step default", () => {
      const config: TimeoutConfig = { default: 420000 };
      expect(resolveStepTimeout("Write tests", config)).toBe(420000);
    });
  });

  describe("Validation and safety caps", () => {
    it("caps timeout at 30 minutes", () => {
      const config: TimeoutConfig = {
        stepOverrides: { "Write tests": 3600000 },
      };
      expect(resolveStepTimeout("Write tests", config)).toBe(MAX_TIMEOUT_MS);
    });

    it("zero timeout falls back to next level", () => {
      const config: TimeoutConfig = {
        stepOverrides: { "Write tests": 0 },
      };
      // Falls through to config default (none) → built-in → 30 min
      expect(resolveStepTimeout("Write tests", config)).toBe(1800000);
    });

    it("negative timeout falls back to next level", () => {
      const config: TimeoutConfig = {
        stepOverrides: { "Write tests": -1 },
      };
      expect(resolveStepTimeout("Write tests", config)).toBe(1800000);
    });

    it("empty config returns defaults", () => {
      expect(resolveStepTimeout("Write tests", {})).toBe(1800000);
      expect(resolveStepTimeout("Open PR", {})).toBe(300000);
    });

    it("undefined config returns defaults", () => {
      expect(resolveStepTimeout("Write tests", undefined)).toBe(1800000);
    });
  });

  describe("Resolution order", () => {
    it("follows 4-level cascade: config step → config default → built-in → global", () => {
      // Level 1: config step override
      expect(
        resolveStepTimeout("Write tests", { stepOverrides: { "Write tests": 600000 } })
      ).toBe(600000);

      // Level 2: config default (no step override)
      expect(resolveStepTimeout("Open PR", { default: 420000 })).toBe(420000);

      // Level 3: built-in step default (no config)
      expect(resolveStepTimeout("Write tests")).toBe(1800000);

      // Level 4: global fallback (no config, no built-in)
      expect(resolveStepTimeout("Open PR")).toBe(DEFAULT_TIMEOUT_MS);
    });
  });
});
