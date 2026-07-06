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
  TRANSIENT_ERROR_PATTERNS,
  TRANSIENT_RETRY_CAP,
  TRANSIENT_RETRY_DELAY_MS,
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
