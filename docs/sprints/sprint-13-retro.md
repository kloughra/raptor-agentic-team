# Sprint 13 Retrospective — raptor-agentic-team

## Proposals

### 1. PO Proposal

**Section**: Failure Modes & Escalation (Circuit Breaker)
**Type**: addition
**Proposal**: Add a **user-actionable failure fast-path** to the Circuit Breaker: "If a failure is caused by a condition only the user can resolve — billing/spend limits, expired credentials, required manual approvals, or an external state change outside the repo — the role must NOT consume retry attempts. Escalate to the user immediately after the first occurrence with `[ESCALATE] {role}: user-actionable blocker — {condition}. Retrying cannot succeed until the user acts.` Additionally, when an external actor (typically the user) has already completed a workflow step out-of-band (e.g., a PR manually merged on GitHub), the role must verify the end state (code verifiably on main) and treat the step as successfully complete — not as a failure to retry."
**Rationale**: This sprint, spend-limit errors ("You've hit your monthly spend limit") burned 2 attempts before the no-progress short-circuit fired — on three separate occasions — even though no retry could possibly succeed until the user acted. Separately, both PR #29 and PR #30 were manually merged by the user before step 9, and the merge step needed ad-hoc demo-feedback guidance ("treat already-merged as success") to avoid classifying an already-achieved outcome as a failure. Both are the same class of gap: the 3-attempt circuit breaker assumes failures are agent-resolvable, and the workflow assumes steps are only completed by agents.
**Impact**: Future sprints stop wasting attempts (and tokens) retrying unretryable conditions, users are alerted the moment their action is required rather than after multiple doomed retries, and externally-completed steps (manual merges, out-of-band fixes) resolve cleanly by verifying end state instead of relying on per-sprint verbal instructions at checkpoints.

### 2. ARCHITECT Proposal

**Section**: Git & Delivery Conventions → Merge Policy
**Type**: addition
**Proposal**: Add an idempotent-merge rule to the Merge Policy: "Merge steps must be **state-verifying, not action-verifying**. If the merge action reports the PR is already merged (e.g., the user merged it manually on GitHub), the role must verify the merge commit is reachable on `main` and treat the step as **success** — not a failure, and not an attempt counted toward the circuit breaker. More generally, any workflow step whose intended end state is already satisfied by external action (user, hotfix, prior run) is complete upon verification of that end state; the role posts `[STATUS] {role}: {step} — already satisfied externally, verified on main` and proceeds."
**Rationale**: This sprint, both PR #29 and PR #30 were merged manually by the user before step 9 ran. Each time, the team only avoided misclassifying the "pull request already merged" response as a merge failure because the demo-feedback checkpoint carried ad-hoc instructions ("treat the already-merged response as success"). That guidance lived in ephemeral checkpoint feedback and had to be repeated verbatim across two consecutive features — a clear sign the rule belongs in the standing process, not in per-sprint steering.
**Impact**: Future sprints handle externally-completed steps without per-checkpoint manual instructions, eliminating a recurring class of false merge failures that would otherwise burn circuit-breaker attempts (or escalate spuriously) when the desired outcome — code verifiably on `main` — is already achieved. It also generalizes cleanly to other steps where the user acts out-of-band, keeping the orchestrated workflow convergent with reality rather than fighting it.

### 3. QA Proposal

**Section**: QA Engineer — Responsibilities (rule 12) and PR Description Template
**Type**: modification
**Proposal**: Extend QA responsibility 12 to require that every constraint-guarding or parity test include a recorded **RED-verification note** — a comment in the test file (or a linked PR note) stating exactly how the test was proven to FAIL against the pre-change or deliberately-violated code path (e.g., "RED verified by reverting C2 dispatcher change / by hand-crafting invariant-violating state per architecture constraint 4"). Correspondingly, add a line to the PR Description Template: `## RED Verification — {list of constraint-guarding tests and how each was shown to fail pre-fix}`. Additionally, codify that when the architecture defines a contract invariant (e.g., "outcomes.length === selected.length on EVERY path"), QA must pin that invariant on all paths **including I/O-failure paths**, not just happy paths.
**Rationale**: Rule 12 worked exceptionally well this sprint — both PR #29 and PR #30 reviews explicitly praised that "every constraint-guarding test documents its RED-against-pre-fix behavior" and that seam tests drove the real `runSprintFromStep` paths. But that documentation practice was an emergent discipline I applied voluntarily, not a written requirement: TEAM.md rule 12 says to *verify* the test fails pre-change, but never says to *record* how. The Architect's constraint 4 (hand-crafted invariant-violating state) and the PO's endorsement of the AC-9 fixture design both leaned on this evidence being visible to reviewers. The outcome-total invariant on every path including I/O failure was likewise called out as "the contract to pin hardest" — also currently unwritten.
**Impact**: Future sprints get the same review quality by rule rather than by habit. Reviewers (Architect, PO) can verify test adequacy directly from the PR instead of trusting or re-deriving the RED check; a future QA agent cannot silently skip the pre-fix failure proof; and invariant coverage on failure paths — the exact class of gap that caused the Sprint 12 divergence bugs this sprint repaired — becomes an explicit, checkable requirement instead of tribal knowledge.

### 4. ENGINEER Proposal

**Section**: Git & Delivery Conventions — Merge Policy (with a corresponding row in Failure Modes & Escalation)
**Type**: addition
**Proposal**: Add an explicit rule for externally-merged PRs: "If the merge step encounters a PR that is already merged (e.g., the user merged it manually on GitHub between demo and step 9), the Engineer MUST verify the merge commit exists on `main` (e.g., `git log main` shows the PR's changes or the merge commit SHA) and then treat the step as **successful** — post `[STATUS] Engineer: merge — PR #{N} already merged externally (commit {sha}), verified on main` and proceed. An 'already merged' response must NOT be classified as a merge failure and must NOT count as a failed attempt toward the circuit breaker." Add a matching Failure Modes row: "**PR already merged externally** → Verify changes are on main; record status; treat as success."
**Rationale**: This exact situation occurred twice this sprint — both PR #29 (merge commit c07eeb9) and PR #30 were merged manually by the user before step 9 ran. Each time, the team only handled it correctly because the demo-feedback checkpoint included ad-hoc instructions ("treat the already-merged response as success"). Without that verbatim guidance, the natural interpretation of a `gh pr merge` error response is a merge failure, which would burn retry attempts, potentially trip the 3-attempt circuit breaker, and escalate to the user over a non-problem — the code was verifiably already on main.
**Impact**: Future sprints handle user-merged PRs deterministically without needing per-sprint checkpoint instructions. It eliminates a recurring false-failure class from the merge step, prevents wasted retry attempts and spurious `[ESCALATE]` interruptions, and codifies the verification step (confirm the changes are actually on main) so "already merged" is proven rather than assumed.

## User Decision
- Proposal 1: Adopted
- Proposal 2: Adopted
- Proposal 3: Adopted
- Proposal 4: Deferred

## Applied Changes
- PO proposal → fallback ("Adopted Retro Improvements (Unplaced)"); target "Failure Modes & Escalation (Circuit Breaker)" not found
- ARCHITECT proposal → fallback ("Adopted Retro Improvements (Unplaced)"); target "Git & Delivery Conventions → Merge Policy" not found
- QA proposal → fallback ("Adopted Retro Improvements (Unplaced)"); target "QA Engineer — Responsibilities (rule 12) and PR Description Template" not found
