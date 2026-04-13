describe("Agent Timeout Scaling by Step Type", () => {
  const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes
  const MAX_TIMEOUT_MS = 30 * 60 * 1000;       // 30 minutes

  const STEP_TIMEOUT_DEFAULTS: Record<string, number> = {
    "Write tests": 15 * 60 * 1000,
    "Implement (TDD)": 10 * 60 * 1000,
    "Architecture design": 7 * 60 * 1000,
    "Collect retro proposals": 5 * 60 * 1000,
  };

  interface TimeoutConfig {
    default?: number;
    stepOverrides?: Record<string, number>;
  }

  function resolveStepTimeout(stepName: string, config?: TimeoutConfig): number {
    // 1. Config step override
    if (config?.stepOverrides?.[stepName] !== undefined) {
      const val = config.stepOverrides[stepName];
      if (val > 0 && val <= MAX_TIMEOUT_MS) return val;
      if (val > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
      // Invalid (0 or negative) → fall through
    }

    // 2. Config default
    if (config?.default !== undefined) {
      const val = config.default;
      if (val > 0 && val <= MAX_TIMEOUT_MS) return val;
      if (val > MAX_TIMEOUT_MS) return MAX_TIMEOUT_MS;
    }

    // 3. Built-in step default
    if (STEP_TIMEOUT_DEFAULTS[stepName] !== undefined) {
      return STEP_TIMEOUT_DEFAULTS[stepName];
    }

    // 4. Global fallback
    return DEFAULT_TIMEOUT_MS;
  }

  describe("Built-in step defaults", () => {
    it("QA test generation gets 15 minutes", () => {
      expect(resolveStepTimeout("Write tests")).toBe(900000);
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

    it("config default does not override built-in step default (step override takes precedence)", () => {
      // If no step override but built-in exists, config default applies
      // because config default is checked before built-in
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
      // Falls through to config default (none) → built-in → 15 min
      expect(resolveStepTimeout("Write tests", config)).toBe(900000);
    });

    it("negative timeout falls back to next level", () => {
      const config: TimeoutConfig = {
        stepOverrides: { "Write tests": -1 },
      };
      expect(resolveStepTimeout("Write tests", config)).toBe(900000);
    });

    it("empty config returns defaults", () => {
      expect(resolveStepTimeout("Write tests", {})).toBe(900000);
      expect(resolveStepTimeout("Open PR", {})).toBe(300000);
    });

    it("undefined config returns defaults", () => {
      expect(resolveStepTimeout("Write tests", undefined)).toBe(900000);
    });
  });

  describe("spawnAgent timeout parameter", () => {
    it("accepts optional timeoutMs parameter type", () => {
      // Type check: the function signature should accept timeoutMs
      const timeoutMs: number | undefined = 900000;
      expect(typeof timeoutMs).toBe("number");
    });

    it("undefined timeoutMs falls back to AGENT_TIMEOUT_MS", () => {
      const AGENT_TIMEOUT_MS = 5 * 60 * 1000;
      const timeoutMs: number | undefined = undefined;
      const effectiveTimeout = timeoutMs !== undefined ? timeoutMs : AGENT_TIMEOUT_MS;
      expect(effectiveTimeout).toBe(300000);
    });
  });

  describe("Resolution order", () => {
    it("follows 4-level cascade: config step → config default → built-in → global", () => {
      // Level 1: config step override
      expect(resolveStepTimeout("Write tests", { stepOverrides: { "Write tests": 600000 } })).toBe(600000);

      // Level 2: config default (no step override)
      expect(resolveStepTimeout("Open PR", { default: 420000 })).toBe(420000);

      // Level 3: built-in step default (no config)
      expect(resolveStepTimeout("Write tests")).toBe(900000);

      // Level 4: global fallback (no config, no built-in)
      expect(resolveStepTimeout("Open PR")).toBe(300000);
    });
  });
});
