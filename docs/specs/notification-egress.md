---
slug: notification-egress
status: draft
sprint: 16
---
# Notification Egress — Out-of-Band Sprint Notifications

## User Story
As a Raptor user who wants to step away while a sprint runs, when the orchestrator reaches a key lifecycle event — a **checkpoint** is reached, an **escalation** is raised, the sprint **completes**, or the sprint **fails** — I want Raptor to **ping me out-of-band** (starting with a Slack incoming webhook) with what happened and the exact command I need to run next, so that I can stay informed and re-engage only when Raptor actually needs me, instead of babysitting the run. This is the first substrate piece of the autonomous-Raptor north star: run sprints → notify me out-of-band → I stay informed → I'm asked for guidance when the backlog is dry.

## Background

**Why this, why now.** Sprint 15 took **53 `resume_sprint` calls** to shepherd to completion. The autonomy north star (user north-star design session 2026-07-07) is: Raptor runs sprints, notifies the user out-of-band at the moments that matter, keeps them informed, and asks for guidance when the backlog is dry. There is no outbound notification path today — a running sprint that reaches a checkpoint, escalates, completes, or fails does so silently; the user only learns by polling `get_project_status` or re-invoking the tool. This item builds the minimal outbound hook.

**Promotion & supersession.** Promoted Inbox → Sprint 16 (Autonomy substrate) 2026-07-12. This feature **supersedes** the `discord-integration` Inbox item: Discord becomes a future driver behind the same pluggable channel abstraction, not a separate integration.

**Trust dependency (same sprint).** The notification payload MUST describe what *actually* happened. Because Raptor tools currently return failures as `{status: "error"}` strings rather than throwing (see `surface-tool-errors-to-openstory`, also in Sprint 16), a payload built from an agent's self-report could counterfeit a "complete" when the sprint actually failed. This spec therefore requires payloads to be derived from **persisted sprint state and git**, never from agent self-report. The two items are co-scheduled deliberately.

**Config dead-plumbing class to avoid.** `config-keys-parsed-vs-declared` (Sprint 12 tech-debt flag) documents that `RaptorConfig` has repeatedly *declared* config keys that `loadConfig` never *parsed*, silently ignoring user settings for six sprints. This feature adds `notifications.slack_webhook_url`; it MUST be parsed in `loadConfig` (mirroring `parseTimeouts`/`parseModels`) and MUST ship a parsed-vs-declared conformance test so the new key cannot become dead plumbing.

### Verified current behavior (2026-07-12, current `main`)
- `RaptorConfig` (`src/config.ts:9`) declares `timeouts`, `models`, `dinoNames`, and several unparsed keys; `loadConfig` (`src/config.ts:52`) currently parses only `projectsBaseDir`, `teamTemplatePath`, `dinoNames`, `timeouts`, and `models` (via `parseTimeouts`/`parseModels`). There is **no** `notifications` key today.
- `parseModels` and `parseTimeouts` establish the parse pattern: type-guarded, field-wise-dropping, never-throwing helpers that return `undefined` for an absent/malformed key so an absent config is byte-identical to prior behavior.
- The orchestrator persists sprint state as JSON under `~/.raptor/{slug}/sprint-N.json` and reaches its lifecycle events (`paused`/checkpoint, `escalated`, `complete`, `failed`) inside `runner.ts` / `multi-runner.ts`. State status and checkpoint records are the authoritative record of what happened — not agent stdout.
- There is no outbound network egress in Raptor today; all I/O is local files + `simple-git` + spawning `claude`.

## Acceptance Criteria

1. **Four notification events fire.** Raptor emits an outbound notification when, and only when, the orchestrator reaches each of these lifecycle events for a sprint:
   - **checkpoint reached** — the sprint parks awaiting user input (status `paused` / a new `checkpoints[]` entry);
   - **escalation raised** — a step escalates to the user (status `escalated`, e.g. circuit-breaker cap or user-actionable failure);
   - **sprint complete** — the sprint reaches truthful completion (status `complete`, per the Sprint 13 completion contract);
   - **sprint failed** — the sprint terminates in `failed`.
   No notification fires for ordinary intra-step progress (handoffs, retries that don't change sprint status).

2. **Payload is derived from persisted state / git, never agent self-report.** Every notification's content (which event, sprint number, feature slug(s), status, checkpoint/escalation reason) is read from the persisted sprint state and/or git — not from an agent's returned message text. A step whose agent *claims* success but whose persisted state is not `complete` MUST NOT produce a "complete" notification. (Ties to `surface-tool-errors-to-openstory`, same sprint.)

3. **Actionable payload — includes the next command.** For events that require user action (checkpoint reached, escalation raised), the notification includes the checkpoint/escalation context AND the **exact `resume_sprint` command** the user must run to re-engage (project, sprint, and the relevant action/feature arguments), so the user can act by copy-paste without reconstructing it.

4. **Pluggable channel abstraction.** Notification delivery goes through a **channel abstraction** (a driver interface), not a hard-coded Slack call. A single **Slack incoming-webhook driver** ships this sprint. The abstraction MUST make adding a future driver (e.g. Discord) a matter of implementing the interface — no changes to the event-emission call sites. Discord is explicitly a *future* driver (this supersedes the `discord-integration` Inbox item); it is NOT built this sprint.

5. **Slack driver is webhook-only (no OAuth/bot).** The Slack driver POSTs the message payload to a configured **incoming-webhook URL**. It does NOT use OAuth, a bot token, or the Slack Web API. The minimal surface is: build a message body from the event payload → HTTP POST to the webhook URL.

6. **Configured via `notifications.slack_webhook_url`, parsed in `loadConfig`.** The webhook URL is read from `notifications.slack_webhook_url` in `~/.raptor/config.json`. `RaptorConfig` declares a `notifications` key AND `loadConfig` parses it (mirroring `parseTimeouts`/`parseModels`: type-guarded, field-wise-dropping, never-throwing). A malformed or absent `notifications` value degrades to "no notifications" and never crashes `loadConfig`.

7. **Parsed-vs-declared conformance test.** A test asserts that the `notifications` key (and specifically `slack_webhook_url`) is actually parsed by `loadConfig` — i.e. setting it in config produces a parsed value the notifier can read — so this key cannot join the `config-keys-parsed-vs-declared` dead-plumbing class. RED-verification note required per TEAM.md QA rule 12 (the test must FAIL against a `loadConfig` that declares but does not parse `notifications`).

8. **Notifications are strictly opt-in / off by default.** With no `notifications.slack_webhook_url` configured, Raptor behaves **byte-for-byte** as it does today: no network calls, no new prompts, no behavior change to the sprint run. A default-off parity assurance is required (per TEAM.md QA rule 13): the sprint run path with no notification config produces identical observable behavior to pre-feature.

9. **Notification failure never breaks the sprint.** Sending a notification is **best-effort**. A failed POST (network error, non-2xx, bad URL, timeout) MUST NOT fail the step, alter sprint state, block a checkpoint, or throw into the orchestrator. The failure is logged/surfaced but the sprint proceeds (or parks) exactly as it would with notifications off. Notification I/O has no retry/escalation coupling to the circuit breaker.

10. **No secret leakage.** The webhook URL (a secret) is never written into sprint state, git commits, the backlog, demo materials, or notification *content*. It is read from config only and used only as the POST target.

11. **One notification per event (no duplicate spam).** Re-entering the runner (e.g. a `resume_sprint` that re-evaluates an already-parked checkpoint, or a re-run that re-reads a terminal state) MUST NOT re-fire a notification for an event already notified. The dedup mechanism (state marker vs. edge-detection) is an Architect decision, but the observable contract is: a given lifecycle event notifies at most once.

12. **Tests exercise the production seam.** Regression tests drive the real emission path — the orchestrator reaching a checkpoint/escalation/complete/failed state with a webhook configured results in the driver being invoked with a payload derived from persisted state (HTTP boundary mocked/faked, not the internal call). Each constraint-guarding test carries a RED-verification note per TEAM.md QA rule 12. At minimum: (a) each of the four events triggers exactly one send; (b) payload content matches persisted state, not a divergent agent-report fixture; (c) an actionable event's payload contains the exact `resume_sprint` command; (d) a failing POST does not disturb sprint state or flow; (e) default-off produces zero sends.

## Edge Cases
- **Webhook configured but unreachable / returns 5xx.** Best-effort per AC #9 — log and continue; the sprint parks/completes normally. No retry storm.
- **Malformed `notifications` value** (a string instead of an object, `slack_webhook_url` not a string, empty string). Field-wise drop per AC #6 → treated as unconfigured → no notification, no crash.
- **Multi-feature sprint reaches mixed terminal state** (one feature complete, one escalated). The notification reflects the *persisted derived sprint status* (per Sprint 13 `deriveSprintStatus`), not a single feature's report; the actionable command targets the feature the user must act on.
- **Agent self-reports success but state is not `complete`.** No "complete" notification (AC #2) — this is the exact counterfeit the persisted-state rule prevents.
- **Rapid re-`resume_sprint` on a still-parked checkpoint.** No duplicate checkpoint notification (AC #11).
- **Config present but `slack_webhook_url` absent** (e.g. a future `notifications.discord_webhook_url` set instead). No Slack send; no crash. The Slack driver only fires when its own URL is present.
- **Very long escalation/checkpoint reason text.** The payload should remain a well-formed Slack message (truncation acceptable); a payload-size limit is an Architect detail, not a spec requirement.

## Out of Scope
- **Building the Discord driver.** Discord is a *future* driver behind the same abstraction (AC #4); only the interface must accommodate it. This supersedes `discord-integration` (Inbox) as the tracking item, but no Discord code ships this sprint.
- **Slack OAuth / bot tokens / the Slack Web API / interactive Slack actions** (buttons that call back into Raptor). Webhook POST only (AC #5). Inbound/interactive notification is a separate future concern.
- **`surface-tool-errors-to-openstory`** — the tool-error-as-first-class-event work is its own Sprint 16 item; this spec depends on persisted state being trustworthy but does not itself change how tools return errors.
- **A per-project or per-event notification routing / filtering config** (mute certain events, per-project channels). This sprint ships a single global webhook that receives all four events. Granular routing is a future item.
- **Inbound notifications / two-way chat / a Raptor bot presence.** Egress only, as the slug says.
- **Notification for backlog-dry / "ask for guidance" prompting.** The north-star "asks for guidance when the backlog is dry" behavior is a separate future item; this spec covers only the four in-sprint lifecycle events (AC #1).
- **Email / SMS / webhook-to-arbitrary-URL generic drivers.** Only the Slack incoming-webhook driver ships; the abstraction allows more later.
- **Retry/queue/delivery-guarantee semantics for notifications.** Best-effort, fire-and-forget (AC #9). No durable outbox.

## Open Questions
1. **Emission seam & module location.** Where do the four events emit from — a single notifier invoked at the state-transition points in `runner.ts`/`multi-runner.ts`, or a hook layered onto `saveSprintState`/status changes? Which module owns the channel abstraction and Slack driver? *Technical decision — Architect.*
2. **HTTP client for the POST.** Node built-in `fetch`/`https` vs. adding a dependency. PO intent: prefer zero new dependencies consistent with the codebase's minimal-dep stance, but the Architect owns this. Whatever is chosen, the send path must be non-blocking/best-effort (AC #9).
3. **Duplicate-suppression mechanism (AC #11).** A persisted "notified" marker on the sprint/checkpoint record vs. edge-detection on status transitions. *Architect to specify* — the observable contract (at most one notification per event) is fixed; the mechanism is not.
4. **Exact `resume_sprint` command reconstruction (AC #3).** How does the notifier assemble the precise `resume_sprint` argument string (action, `--feature`) from checkpoint/escalation state — especially for multi-feature escalations where the actionable feature must be named? *Architect/QA to confirm the command maps 1:1 to what the user would actually run.*
5. **Message formatting.** Plain-text vs. Slack Block Kit for the webhook body. PO intent: readable, includes event + sprint + status + next command; Block Kit is a nicety, not a requirement. *Architect's call.*
6. **Payload derivation source of truth (AC #2).** Precisely which persisted fields (sprint `status`, `checkpoints[]`, `features[].status`, git head/PR state) compose each event's payload, and how "sprint complete" is confirmed against the Sprint 13 truthful-completion contract rather than an agent report. *Architect to enumerate the exact read set.*
