/**
 * Unit tests — failure classification & signature derivation (Sprint 12)
 *
 * Feature:      progress-aware-circuit-breaker (CB-1, CB-2)
 * Spec:         docs/specs/progress-aware-circuit-breaker.md (AC 2, 5-6)
 * Architecture: docs/architecture/progress-aware-circuit-breaker.md §1
 *
 * Pure, deterministic string matching only — no LLM calls (spec constraint).
 * The broader contract surface (constants, registry enumerability, the full
 * named-class table) is pinned by the QA integration suite; these colocated
 * units cover the derivation mechanics per the architecture test-surface map.
 */

import { describe, it, expect } from "@jest/globals";
import {
  classifyFailure,
  deriveFailureSignature,
  resolveUserAction,
  TRANSIENT_ERROR_PATTERNS,
  TRANSIENT_RETRY_CAP,
  TRANSIENT_RETRY_DELAY_MS,
  USER_ACTIONABLE_ERROR_PATTERNS,
  UserActionablePattern,
} from "./failure-classification";

describe("classifyFailure", () => {
  it("classifies the Sprint 11 specimen as transient", () => {
    expect(classifyFailure("socket connection closed unexpectedly")).toBe("transient");
  });

  it.each([
    "connect ECONNREFUSED 127.0.0.1:443",
    "ECONNRESET while streaming",
    "request failed: ETIMEDOUT",
    "getaddrinfo ENOTFOUND api.anthropic.com",
    "getaddrinfo EAI_AGAIN api.anthropic.com",
    "write EPIPE",
    "TypeError: fetch failed",
    '{"type":"error","error":{"type":"overloaded_error"}}',
    "HTTP 429: rate limit exceeded",
    "hit the rate limit, backing off",
    "502 bad gateway",
    "503 service unavailable",
    "500 internal server error",
  ])("transient: %s", (msg) => {
    expect(classifyFailure(msg)).toBe("transient");
  });

  it.each([
    "agent produced no output",
    "agent output exceeded 10MB buffer",
    "agent idle-killed after 1800000ms with no stdout output",
    "agent killed at hard ceiling 3600000ms (still streaming — absolute runtime limit)",
    "agent timed out after 900000ms",
    "Missing required artifacts: docs/specs/foo.md",
    "SyntaxError: unexpected token",
  ])("deterministic: %s", (msg) => {
    expect(classifyFailure(msg)).toBe("deterministic");
  });

  it("classification is derived from an enumerable, code-only registry", () => {
    expect(Array.isArray(TRANSIENT_ERROR_PATTERNS)).toBe(true);
    for (const re of TRANSIENT_ERROR_PATTERNS) {
      expect(re).toBeInstanceOf(RegExp);
      // No /g flags: stateful lastIndex would make classification
      // non-deterministic across successive calls.
      expect(re.flags).not.toContain("g");
    }
  });

  it("pins the Architect-ruled constants (cap 5, fixed 15s delay)", () => {
    expect(TRANSIENT_RETRY_CAP).toBe(5);
    expect(TRANSIENT_RETRY_DELAY_MS).toBe(15_000);
  });
});

// ===========================================================================
// Sprint 15 — user-actionable-failure-class (colocated units)
//
// RED-VERIFICATION (TEAM.md QA rule 12): every `it` below FAILS against the
// pre-change classifier. classifyFailure returned only "transient" |
// "deterministic", so a spend-limit / invalid-model string classified
// "deterministic"; USER_ACTIONABLE_ERROR_PATTERNS and resolveUserAction did
// not exist (compile-time RED). Re-verify by reverting failure-classification.ts.
// ===========================================================================

describe("classifyFailure — user-actionable class (Sprint 15, AC 1-4, 13)", () => {
  it("classifies the billing spend-limit specimen as user-actionable", () => {
    expect(classifyFailure("You've hit your monthly spend limit")).toBe("user-actionable");
  });

  it.each([
    "You've hit your monthly spend limit",
    "Error: monthly spend limit exceeded for this account",
    "monthly usage limit reached",
    "usage limit reached — please raise your limit",
  ])("billing phrasing drift → user-actionable: %s", (msg) => {
    expect(classifyFailure(msg)).toBe("user-actionable");
  });

  it.each([
    "unknown model: definitely-not-a-real-model-xyz",
    "error: invalid model name provided",
    "unrecognized model requested",
    "model definitely-not-a-real-model does not exist",
    "the requested model is invalid",
    "model claude-bogus not found",
  ])("invalid-model rejection → user-actionable: %s", (msg) => {
    expect(classifyFailure(msg)).toBe("user-actionable");
  });

  it("a user-actionable failure is NOT transient and NOT deterministic (AC 2)", () => {
    const cls = classifyFailure("You've hit your monthly spend limit");
    expect(cls).not.toBe("transient");
    expect(cls).not.toBe("deterministic");
  });

  it("precedence: matches BOTH user-actionable and transient → user-actionable (Edge Case)", () => {
    const ambiguous = "usage limit reached (429 rate limit)";
    // The transient registry alone would claim this string...
    expect(TRANSIENT_ERROR_PATTERNS.some((re) => re.test(ambiguous))).toBe(true);
    // ...but user-actionable is checked first: escalate-now beats retry-loop.
    expect(classifyFailure(ambiguous)).toBe("user-actionable");
  });

  it("no-regression: unmatched errors classify exactly as today (AC 12)", () => {
    expect(classifyFailure("agent produced no output")).toBe("deterministic");
    expect(classifyFailure("socket connection closed unexpectedly")).toBe("transient");
    // A pure transient rate-limit (no usage/spend wording) stays transient.
    expect(classifyFailure("HTTP 429: rate limit exceeded")).toBe("transient");
  });
});

describe("USER_ACTIONABLE_ERROR_PATTERNS registry (Sprint 15, AC 3, 4, 13)", () => {
  it("is an enumerable, code-only array of at least two seed entries", () => {
    expect(Array.isArray(USER_ACTIONABLE_ERROR_PATTERNS)).toBe(true);
    expect(USER_ACTIONABLE_ERROR_PATTERNS.length).toBeGreaterThanOrEqual(2);
  });

  it("every entry carries a RegExp pattern and a non-empty action, no /g flag (AC 13)", () => {
    for (const entry of USER_ACTIONABLE_ERROR_PATTERNS as UserActionablePattern[]) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(entry.pattern.flags).not.toContain("g");
      expect(typeof entry.action).toBe("string");
      expect(entry.action.trim().length).toBeGreaterThan(0);
    }
  });

  it("ships a billing seed and an invalid-model seed (AC 4)", () => {
    expect(
      USER_ACTIONABLE_ERROR_PATTERNS.some((e) => e.pattern.test("You've hit your monthly spend limit"))
    ).toBe(true);
    expect(
      USER_ACTIONABLE_ERROR_PATTERNS.some((e) => e.pattern.test("unknown model: definitely-not-a-real-model-xyz"))
    ).toBe(true);
  });
});

describe("resolveUserAction (Sprint 15, AC 7)", () => {
  it("names raising the usage limit for a billing failure", () => {
    const action = resolveUserAction("You've hit your monthly spend limit");
    expect(action).not.toBeNull();
    expect(action!.toLowerCase()).toContain("claude.ai/settings/usage");
  });

  it("names fixing models config for an invalid-model failure", () => {
    const action = resolveUserAction("unknown model: definitely-not-a-real-model-xyz");
    expect(action).not.toBeNull();
    expect(action!).toContain("~/.raptor/config.json");
    expect(action!.toLowerCase()).toMatch(/models\.(byrole|default)/);
  });

  it("returns null when no user-actionable pattern matches", () => {
    expect(resolveUserAction("agent produced no output")).toBeNull();
    expect(resolveUserAction("socket connection closed unexpectedly")).toBeNull();
  });

  it("first-match-wins on a multi-match summary (billing before invalid-model, OQ3)", () => {
    const both = "You've hit your monthly spend limit. Also: unknown model: bogus";
    expect(resolveUserAction(both)!.toLowerCase()).toContain("claude.ai/settings/usage");
  });
});

describe("deriveFailureSignature — named classes", () => {
  it("maps the stdin-wait warning to its own class regardless of casing/wrapping (AC 2)", () => {
    const warning =
      "Input must be provided either through stdin or as a prompt argument when using --print";
    expect(deriveFailureSignature(warning)).toBe("stdin-wait-warning");
    expect(deriveFailureSignature(`error: ${warning.toLowerCase()} (exit 1)`)).toBe(
      "stdin-wait-warning"
    );
  });

  it("kill-message classes are duration-insensitive", () => {
    expect(deriveFailureSignature("agent idle-killed after 60000ms with no stdout output")).toBe(
      deriveFailureSignature("agent idle-killed after 1800000ms with no stdout output")
    );
    expect(
      deriveFailureSignature(
        "agent killed at hard ceiling 3600000ms (still streaming — absolute runtime limit)"
      )
    ).toBe("hard-ceiling");
    expect(deriveFailureSignature("agent timed out after 300000ms")).toBe("wall-clock-timeout");
  });

  it("kill messages appended as a suffix after buffered output still match their class", () => {
    // agents.ts appends the kill message as a suffix line when the buffer is
    // non-empty, so the class must match anywhere in the text.
    const withBuffer = "partial agent chatter...\nagent idle-killed after 60000ms with no stdout output";
    expect(deriveFailureSignature(withBuffer)).toBe("idle-timeout");
  });

  it("missing-outputs embeds the sorted pattern list", () => {
    const msg = (list: string) =>
      `Agent completed (exit 0) but did not create required output files: ${list}. The step is not complete until these files exist on disk.`;
    expect(deriveFailureSignature(msg("b/*, a/*"))).toBe(deriveFailureSignature(msg("a/*, b/*")));
    expect(deriveFailureSignature(msg("a/*"))).not.toBe(deriveFailureSignature(msg("b/*")));
    expect(deriveFailureSignature(msg("a/*")).startsWith("missing-outputs:")).toBe(true);
  });

  it("missing-artifacts embeds the sorted artifact list", () => {
    expect(
      deriveFailureSignature("Missing required artifacts: docs/b.md, docs/a.md")
    ).toBe(deriveFailureSignature("Missing required artifacts: docs/a.md, docs/b.md"));
    expect(
      deriveFailureSignature("Missing required artifacts: docs/a.md").startsWith(
        "missing-artifacts:"
      )
    ).toBe(true);
  });
});

describe("deriveFailureSignature — generic normalization fallback", () => {
  it("is deterministic and bounded to a readable 200-char prefix", () => {
    const msg = `failure: ${"x".repeat(1000)}`;
    const sig = deriveFailureSignature(msg);
    expect(sig).toBe(deriveFailureSignature(msg));
    expect(sig.length).toBeLessThanOrEqual(200);
    expect(sig).toContain("failure");
  });

  it("strips durations and ISO-8601 timestamps so retry-varying cosmetics still match", () => {
    expect(deriveFailureSignature("build broke after 120ms at 2026-07-06T10:15:00.000Z")).toBe(
      deriveFailureSignature("build broke after 4500ms at 2026-07-06T23:59:59.999Z")
    );
  });

  it("distinct failure modes still derive distinct signatures", () => {
    expect(deriveFailureSignature("cannot open fileA")).not.toBe(
      deriveFailureSignature("totally different failure mode")
    );
  });
});
