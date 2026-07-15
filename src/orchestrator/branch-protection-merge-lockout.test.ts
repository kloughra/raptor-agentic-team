/**
 * Unit tests — branch-protection-merge-lockout (Sprint 18)
 *
 * Spec:         docs/specs/branch-protection-merge-lockout.md (AC 1, 2, 5, 6, 12)
 * Architecture: docs/architecture/branch-protection-merge-lockout.md
 *
 * Fast TDD unit coverage for the PURE pieces of the feature (the seam-level
 * behavior at BOTH merge loops is asserted in
 * tests/integration/branch-protection-merge-lockout.integration.test.ts):
 *   - the branch-protection signatures classify `user-actionable` and resolve an
 *     action (AC 1, 2) while the bare "not mergeable" conflict string does NOT (C4);
 *   - the registry stays deterministic & code-only (AC 12);
 *   - `buildMergeLockoutEscalation` names PR + action + last error and degrades
 *     gracefully when the PR number is absent (AC 5);
 *   - `deriveReason` enriches the escalation reason with `escalationDetail` (AC 6).
 *
 * RED-verification: every test here FAILS against pre-change code — the
 * branch-protection regexes are absent from USER_ACTIONABLE_ERROR_PATTERNS,
 * `buildMergeLockoutEscalation` does not exist, and `deriveReason` does not append
 * `escalationDetail`.
 */

import { describe, it, expect } from "@jest/globals";
import {
  classifyFailure,
  resolveUserAction,
  USER_ACTIONABLE_ERROR_PATTERNS,
  UserActionablePattern,
} from "./failure-classification";
import { buildMergeLockoutEscalation } from "./runner";
import { deriveNotificationEvent } from "./notifications";
import { SprintState } from "./state";

const BRANCH_PROTECTION_SPECIMENS: Array<{ label: string; stderr: string; actionContains: string }> = [
  { label: "base-branch policy", stderr: "pull request is not mergeable: the base branch policy prohibits the merge", actionContains: "unlock" },
  { label: "protected branch (update refused)", stderr: "protected branch update failed for refs/heads/main", actionContains: "unlock" },
  { label: "branch is protected", stderr: "refusing to update the branch: branch is protected", actionContains: "unlock" },
  { label: "locked base branch (lock_branch)", stderr: "GraphQL: main is a protected branch and cannot be merged (lock_branch enabled)", actionContains: "unlock" },
  { label: "required approving review", stderr: "GraphQL: At least 1 approving review is required by reviewers with write access", actionContains: "approve" },
  { label: "review required (short form)", stderr: "pull request is not mergeable: review required", actionContains: "approve" },
  { label: "code-owner review", stderr: "GraphQL: Changes must be approved by a code owner", actionContains: "approve" },
];

describe("classifyFailure + resolveUserAction — branch-protection specimens (AC 1, 2)", () => {
  it.each(BRANCH_PROTECTION_SPECIMENS)(
    "classifies '$label' as user-actionable and names its action",
    ({ stderr, actionContains }) => {
      expect(classifyFailure(stderr)).toBe("user-actionable");
      const action = resolveUserAction(stderr);
      expect(action).not.toBeNull();
      expect(action!.toLowerCase()).toContain(actionContains);
    }
  );

  it("does NOT classify the bare 'not mergeable' conflict string (C4)", () => {
    expect(classifyFailure("Pull request is not mergeable")).not.toBe("user-actionable");
    expect(resolveUserAction("Pull request is not mergeable")).toBeNull();
  });

  it("no-regression: the billing seed still classifies user-actionable", () => {
    expect(classifyFailure("You've hit your monthly spend limit")).toBe("user-actionable");
  });

  it("no-regression: an ordinary deterministic merge error is not user-actionable", () => {
    const ordinary = "failed to merge pull request: HTTP 422 unexpected server response";
    expect(classifyFailure(ordinary)).not.toBe("user-actionable");
    expect(resolveUserAction(ordinary)).toBeNull();
  });
});

describe("USER_ACTIONABLE_ERROR_PATTERNS registry contract (AC 12)", () => {
  it("contains at least one branch-protection entry beyond the billing seed", () => {
    const bp = USER_ACTIONABLE_ERROR_PATTERNS.filter((e) =>
      BRANCH_PROTECTION_SPECIMENS.some((s) => e.pattern.test(s.stderr))
    );
    expect(bp.length).toBeGreaterThanOrEqual(1);
  });

  it("every entry is a non-/g RegExp paired with a non-empty action", () => {
    for (const entry of USER_ACTIONABLE_ERROR_PATTERNS as UserActionablePattern[]) {
      expect(entry.pattern).toBeInstanceOf(RegExp);
      expect(entry.pattern.flags).not.toContain("g");
      expect(typeof entry.action).toBe("string");
      expect(entry.action.trim().length).toBeGreaterThan(0);
    }
  });

  it("classification is repeatable across successive calls (NFR-1)", () => {
    for (const { stderr } of BRANCH_PROTECTION_SPECIMENS) {
      expect(classifyFailure(stderr)).toBe(classifyFailure(stderr));
    }
  });
});

describe("buildMergeLockoutEscalation — actionable message (AC 5)", () => {
  const action = "Unlock `main` (branch protection is blocking the squash-merge) or merge the PR manually.";
  const lastError = "pull request is not mergeable: the base branch policy prohibits the merge";

  it("names the PR number, the action, and the last error", () => {
    const msg = buildMergeLockoutEscalation(42, action, lastError);
    expect(msg).toContain("42");
    expect(msg).toContain(action);
    expect(msg).toContain(lastError);
  });

  it("omits a stray PR reference when the PR number is absent", () => {
    for (const pr of [null, undefined]) {
      const msg = buildMergeLockoutEscalation(pr, action, lastError);
      expect(msg).not.toMatch(/#(null|undefined)/);
      expect(msg).toContain(action);
    }
  });

  it("is byte-identical (pure) for identical inputs", () => {
    expect(buildMergeLockoutEscalation(42, action, lastError)).toBe(
      buildMergeLockoutEscalation(42, action, lastError)
    );
  });
});

describe("deriveReason enrichment — escalationDetail names the action (AC 6)", () => {
  it("a notification derived from a lockout-escalated state names the action", () => {
    const detail = "PR #42 blocked at merge — branch protection prevents the automated squash-merge.\nAction required: Unlock `main` or merge manually.\nLast error: base branch policy prohibits the merge";
    const state: SprintState = {
      project: "demo",
      sprint: 18,
      status: "escalated",
      currentStep: 9,
      branchName: "sprint-18/branch-protection-merge-lockout",
      steps: [
        {
          step: 9,
          role: "engineer",
          name: "Merge PR",
          status: "escalated",
          artifacts: [],
          completedAt: null,
          attempts: 1,
          failures: [],
          escalationReason: "user-actionable",
          escalationDetail: detail,
        },
      ],
      checkpoints: [],
      dod: {
        codeCommitted: false,
        testsPass: false,
        prReviewApproved: false,
        poAccepted: false,
        demoCompleted: false,
      },
      retroProposals: null,
      features: null,
      currentFeatureSlug: null,
    };

    const event = deriveNotificationEvent(state, {
      projectSlug: "demo",
      occurredAt: "2026-07-15T00:00:00.000Z",
    });
    expect(event).not.toBeNull();
    expect(event!.event).toBe("escalation");
    expect(event!.reason).not.toBeNull();
    expect(event!.reason!.toLowerCase()).toContain("unlock");
  });
});
