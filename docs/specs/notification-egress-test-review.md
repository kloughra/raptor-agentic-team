---
slug: notification-egress
artifact: po-test-review
status: approved
sprint: 16
reviewer: Petra (PO)
---

# PO Test Review — notification-egress

**Decision: APPROVED. The BDD feature file, the integration suite, and the performance suite are accepted as the acceptance gate for this feature. No blocking changes. Five non-blocking observations are recorded; two are tracked forward to the demo/acceptance checkpoint (step 8) — most importantly the AC #8 default-ON parity question, which needs an explicit user thumbs-up. The Engineer may begin step 5 (Implement, TDD) immediately — the suite is RED at step 3 (the feature modules do not exist) and is designed to turn GREEN only when the notifier, driver, config parse, and dedup marker are implemented per the approved architecture.**

## Scope of Review

- Spec: `docs/specs/notification-egress.md` (AC 1–12, 7 edge cases, 6 Open Questions)
- Architecture: `docs/architecture/notification-egress.md` **(v2 REDESIGN, user tech-approval 2026-07-12)** — egress-free local JSONL sink replaces the v1 Slack webhook; includes an explicit AC-by-AC **§Spec Deviations** table
- BDD: `tests/bdd/notification-egress.feature` (22 scenarios)
- Integration: `tests/integration/notification-egress.integration.test.ts`
- Performance: `tests/performance/notification-egress.perf.test.ts` (NFR-3 latency, NFR-9 durability)

## The spec↔architecture divergence is user-approved — reviewing against the reconciled ACs

The single largest thing to reconcile before this review is legitimate: the tests are written against an architecture that **supersedes several spec ACs** (Slack webhook → local JSONL sink; `notifications.slack_webhook_url` → `notifications.enabled`/`sinkPath`; HTTP egress → zero egress; secret handling → moot). This is **not** an unauthorized mid-sprint AC change. The architecture doc records this as a **user tech-approval on 2026-07-12** ("Raptor must not perform outbound network egress"), and Anky documented the full reconciliation in the §Spec Deviations table rather than editing the already-approved spec. That satisfies my PO boundary ("do not change acceptance criteria mid-sprint without user approval") — the user made the call.

I am therefore reviewing the tests against the **reconciled** acceptance criteria:

| Spec AC | Reconciled by approved architecture | Tests judged against |
|---|---|---|
| AC 1, 2, 3, 7, 11, 12 | **Unchanged** | Spec text verbatim |
| AC 4 | Abstraction KEPT; shipping driver is `JsonlSinkDriver`, not Slack | Reconciled |
| AC 5 | Slack/HTTP POST **removed** (out-of-process watcher, out of scope) | N/A this sprint |
| AC 6 | `notifications.enabled`/`sinkPath`, still parsed in `loadConfig` | Reconciled |
| AC 8 | **Relaxed** — sink on-by-default; `enabled:false` restores byte-parity | Reconciled — **see Flag 1** |
| AC 9 | "failed POST" → "failed sink write"; isolation contract unchanged | Reconciled |
| AC 10 | **Moot** — no secret exists; sink is local, state-derived | Reconciled |
| AC 12 | "HTTP boundary faked" → "sink-append boundary faked/spied" | Reconciled |

The BDD header, integration header, and perf header all disclose this divergence explicitly and cite the §Spec Deviations table — exactly the transparency I want when tests intentionally depart from spec letter.

## Acceptance Criteria → Test Coverage

| AC (reconciled) | BDD | Integration / Perf | Verdict |
|---|---|---|---|
| 1 — four events fire, and only those four | ✅ 5 scenarios | ✅ parametrized loop: paused→checkpoint, escalated→escalation, complete→complete, failed→failed each yield exactly one send; **in-progress → zero sends**. All five `SprintState.status` enum values (`state.ts:89`) covered. | Accept |
| 2 — payload from persisted state, never agent self-report | ✅ 2 scenarios | ✅ escalated state + a divergent `agentReport` "sprint complete" lie → event is `escalation`/`escalated`, no `complete`; project/sprint pulled from state; `deriveNotificationEvent` returns `null` for in-progress | Accept — see Obs 2 |
| 3 — actionable payload carries exact `resume_sprint` command | ✅ 3 scenarios | ✅ checkpoint cmd names project+sprint+action; `buildResumeCommand` maps 1:1 to `{name,sprint,action,feature?}` (OQ4); multi-feature escalation targets the escalated slug; terminal `complete` → `resumeCommand` null | Accept |
| 4 — pluggable driver abstraction (sink ships) | ✅ 2 scenarios | ✅ `resolveDrivers` → single `jsonl-sink` `instanceof JsonlSinkDriver`; a second arbitrary driver receives the identical event with no call-site change | Accept |
| 6 — config parsed in `loadConfig` (not just declared) | ✅ 2 scenarios | ✅ parses `enabled`+`sinkPath`; malformed (`string`/`array`) → `undefined`; wrong field types dropped field-wise; empty-string `sinkPath` dropped | Accept |
| 7 — parsed-vs-declared conformance | ✅ (AC 6/7 scenario) | ✅ setting `notifications` in config yields a parsed value the notifier reads; RED note states it FAILS against a declare-but-don't-parse `loadConfig` (the dead-plumbing class) | Accept |
| 8 — default-off parity via hard off-switch | ✅ 1 scenario | ✅ `enabled:false` → `resolveDrivers` returns `[]`; `emitNotification` with `[]` writes no sink file and no `notifiedEvents` marker (`save` never called) | Accept — **Flag 1** |
| 9 — notification failure never breaks the sprint | ✅ 1 scenario | ✅ throwing driver → `emitNotification` resolves (no reject); status/steps byte-identical; **per-driver isolation** (a good sibling still sends when one throws) | Accept |
| 10 — no secret / no agent stdout in payload | ✅ 1 scenario | ✅ serialized event with an `agentReport` carrying a fake token+URL → line contains none of it; event key-set frozen to the 9 declared state-derived envelope keys | Accept |
| 11 — at most one notification per event (dedup) | ✅ 3 scenarios | ✅ re-enter parked checkpoint → 1 send; re-read terminal ×3 → 1 send; a **distinct new** checkpoint after approval → a 2nd send (guards against over-dedup) | Accept |
| 12 — production seam | ✅ (header contract) | ✅ **real `runSprintFromStep`** drives to a parked checkpoint; the boundary reloads persisted state via `loadSprintState` (the notifier's only input) and dispatches `emitNotification`; re-dispatch after reload → no duplicate. Only sanctioned mock is `spawnAgent`; the driver boundary is a fake `CapturingDriver` | Accept — see Obs 3 |

### NFR coverage

| NFR | Coverage |
|---|---|
| NFR-2 (hard off-switch parity) | ✅ AC 8 tests (zero drivers, no file, no marker) |
| NFR-3 (latency; never a network call) | ✅ perf: 200 sub-1 KB appends well under a network-round-trip budget; per-line size < 1 KB |
| NFR-4 (at-most-once) | ✅ AC 11 dedup tests |
| NFR-5 (no secret / no egress) | ✅ AC 10 frozen key-set + no-secret assertions (no HTTP client exists to invoke) |
| NFR-6 (truthful payload) | ✅ AC 2 divergent-agent-report test |
| NFR-8 (config robustness / conformance) | ✅ AC 6/7 malformed-drop + parsed-vs-declared |
| NFR-9 (durable append-only JSONL) | ✅ integration append-integrity + perf: 100 appends, every prior line intact and well-formed |

### Test categories (TEAM.md QA rule)

- **BDD** ✅ · **Integration** ✅ · **Performance** ✅ (NFR-3/NFR-9).
- **Playwright E2E — Not Applicable.** No UI surface (headless MCP orchestrator). Correctly recorded.
- **QA rule 12 (production-seam + RED notes)** — satisfied: the seam test drives the real runner + real persisted-state reload; every constraint-guard carries a RED-verification note.
- **QA rule 13 (default-off parity test)** — satisfied by the AC 8 tests, which carry their own RED notes.

All applicable categories authored. Accepted.

## Flags tracked forward to the demo/acceptance checkpoint (step 8)

**Flag 1 — AC #8 relaxed from "off by default" to "on by default (opt-out)". Needs an explicit user thumbs-up at the demo. NON-BLOCKING for the tests.**
The approved spec AC #8 says notifications are "strictly opt-in / off by default … byte-for-byte" unchanged when unconfigured. The architecture's §Parity decision **relaxes** this: with egress and the secret removed, the sink is written **on by default** as a local audit trail, and byte-parity is available on demand via `notifications.enabled: false`. The tests correctly encode this (`resolveDrivers(cfg,…)` with no `notifications` key returns one `JsonlSinkDriver`). The architect reasons that the user's redesign directive ("decide whether to gate it") delegated the default. That is plausible, but default-ON is still a **user-observable behavior change for every existing project with no config** — a new `~/.raptor/{slug}/notifications.jsonl` file now appears for each sprint. Because this is exactly the class of change my boundary reserves for the user, I am **not** overriding it and I am **not** blocking the tests on it; I am flagging it for an explicit confirmation at the demo. **If the user prefers default-OFF, the change is tiny and localized:** `resolveDrivers` flips its default and the two AC-4/AC-8 tests that assert default-ON flip with it — the rest of the suite (dedup, payload fidelity, seam, best-effort) is unaffected. Engineer should proceed with default-ON as designed; we confirm at step 8.

**Flag 2 — Spec reconciliation owed at close-out (my task, step 9).** Per Anky's note, the §Spec Deviations table is to be folded into `docs/specs/notification-egress.md` at close-out (request-changes here would only re-run the architecture step; the spec is already approved). At close I will (a) update the spec to reflect the egress-free sink design and mark ACs 5/6/10 superseded/moot, and (b) capture the deferred **external watcher + Slack MCP delivery** as an Inbox backlog item (it is the actual "ping me on Slack" user value, now out of scope this sprint) with its source noted — per my rule-8 deferred-capture obligation. Recorded now so it is not lost.

## Observations (non-blocking, QA discretion — may bundle into the impl PR)

1. **Greenfield RED is coarser than a brownfield RED.** Unlike a bug-fix suite that fails against real pre-change behavior, this whole feature is greenfield, so at step 3 *everything* is RED simply because `notifications.ts` / `notification-driver.ts` / the `notifications` config parse / the `notifiedEvents` marker do not exist (import failure). The RED-verification notes correctly describe the *intended* per-guard failure semantics, and the suite is clearly **designed** to catch the plausible wrong implementations — a naive always-send emitter (in-progress → 0 sends), a self-report-driven payload (escalated-not-complete), over-dedup (the "distinct new checkpoint DOES notify" guard), and missing per-driver isolation (sibling-still-sends). Recommend QA re-confirm each constraint-guard's RED reason against minimal stubs during step 5 (i.e., that a mutant implementation is actually caught), not merely the missing-module RED. This normally falls out of the TDD loop; noting it so it is deliberate.

2. **AC #2 `feature` field is not directly pinned in the single-feature case.** The integration tests assert `project` and `sprint` come from persisted state, and the multi-feature test asserts the escalated slug appears in the *resume command*, but there is no direct integration assertion that `event.feature` equals the derived slug for a single-feature sprint (the BDD scenario "feature reflects the persisted derived value" is stated but not pinned end-to-end). *Optional strengthening:* one assertion that `event.feature === SLUG` on a single-feature derive. Not required — the multi-feature path and the resume-command path exercise the derivation.

3. **The real-runner seam covers the checkpoint event only.** The `complete`/`failed`/`escalated` events are driven through `emitNotification` (the actual production choke point) with hand-built persisted states, while only the `checkpoint` (paused) case is driven through the **real `runSprintFromStep`** to prove the reload-from-disk wiring. This is accepted: `emitNotification` is the single seam, and driving the runner to genuine terminal states would be far more expensive with no additional structural guarantee. Recorded as a conscious, adequate trade-off.

4. **Best-effort marker-after-success retry (OQ3) is covered only by its negative.** The throwing-driver test asserts state is unchanged (so `notifiedEvents` is *not* marked, per "mark after success"), which implies the send retries next invocation — but there is no positive test that a subsequent invocation with a now-working driver actually re-sends. The observable contract (best-effort, at-most-once-on-success) is covered; the retry-next-time behavior is left to the architecture's OQ3 rationale. Acceptable.

5. **`occurredAt` is a fixed test constant, correctly.** Tests inject `OCCURRED_AT` rather than reading a clock, matching the architecture's "no clock inside the pure derivers; `emitNotification` stamps it" decision. Good — keeps the suite deterministic. No change.

## Out-of-scope items correctly excluded

- No Slack driver / HTTP client / OAuth / bot / Web API code — the sink is local `fs` only. ✅
- No external watcher and no Slack MCP delivery (that is the deferred item in Flag 2). ✅
- No edits to `runner.ts` / `multi-runner.ts` implied by the seam tests — the seam is the tool boundary + `emitNotification`. ✅
- No new runtime dependency (NFR-7) — Node built-in `fs`; perf/integration import nothing new. ✅
- No state migration — `notifiedEvents` is additive/optional (`?? []`). ✅
- Discord/email/SMS/generic drivers, routing/filtering, inbound/two-way, backlog-dry prompting — none asserted. ✅

## Decision

**Approved.** The BDD, integration, and performance suites are accepted as the acceptance gate for the user-approved egress-free notification-egress design. The suite comprehensively covers the reconciled ACs 1–4, 6–12 and NFRs 2–6, 8–9 with production-seam discipline and RED-verification notes. The Engineer may begin step 5 (Implement, TDD) immediately; the suite turns GREEN only when the notifier, `JsonlSinkDriver`, `resolveDrivers` off-switch, `parseNotifications`, `deriveNotificationEvent`/`buildResumeCommand`, and the `notifiedEvents` dedup marker are implemented per the approved architecture. Two items are tracked forward to step 8: an explicit user confirmation of the AC #8 default-ON relaxation (Flag 1), and the close-out spec reconciliation plus deferred-watcher backlog capture (Flag 2).
