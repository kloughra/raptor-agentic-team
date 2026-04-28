import { buildCheckpointPrompt } from "./checkpoints";

describe("buildCheckpointPrompt — single-feature mode (existing behavior)", () => {
  it("returns canonical title and context with no feature annotation", () => {
    const prompt = buildCheckpointPrompt("spec-review", "Spec is ready.");
    expect(prompt.type).toBe("spec-review");
    expect(prompt.title).toBe("Spec Review");
    expect(prompt.options).toEqual(["approve", "request-changes"]);
    expect(prompt.feature).toBeUndefined();
    // No "Feature:" prefix in single-feature mode
    expect(prompt.context).not.toContain("**Feature:**");
  });
});

describe("buildCheckpointPrompt — multi-feature mode (additive feature annotation)", () => {
  it("appends ' — {slug}' to the title when featureSlug is provided", () => {
    const prompt = buildCheckpointPrompt(
      "spec-review",
      "Spec for alpha is ready.",
      undefined,
      "alpha"
    );
    expect(prompt.title).toBe("Spec Review — alpha");
    expect(prompt.feature).toBe("alpha");
  });

  it("prefixes context with **Feature:** {slug}\\n\\n when featureSlug is provided", () => {
    const prompt = buildCheckpointPrompt(
      "pr-review",
      "PR open for beta.",
      undefined,
      "beta"
    );
    expect(prompt.context.startsWith("**Feature:** beta\n\n")).toBe(true);
    expect(prompt.feature).toBe("beta");
  });

  it("preserves single-feature behavior when featureSlug is undefined", () => {
    const prompt = buildCheckpointPrompt("demo-feedback", "Demo summary.", undefined, undefined);
    expect(prompt.title).toBe("Demo Feedback");
    expect(prompt.feature).toBeUndefined();
    expect(prompt.context).not.toContain("**Feature:**");
  });

  it("works with all checkpoint types", () => {
    for (const t of ["spec-review", "tech-approval", "pr-review", "demo-feedback", "retro-review"] as const) {
      const prompt = buildCheckpointPrompt(t, "summary", undefined, "gamma");
      expect(prompt.title.endsWith("— gamma")).toBe(true);
      expect(prompt.feature).toBe("gamma");
    }
  });

  it("options array is unchanged in multi-feature mode", () => {
    const prompt = buildCheckpointPrompt("tech-approval", "tech", undefined, "alpha");
    expect(prompt.options).toEqual(["approve", "request-changes"]);
  });
});
