---
slug: notification-egress
spec: docs/specs/notification-egress.md
sprint: 16
status: proposed
---
# Notification Egress — Architecture Design

> **Architect:** Anky 🦕 · **Status:** proposed (technology choices await user approval — see §Technology Choices)

## Overview

This feature adds the first **outbound** path in Raptor: when a sprint reaches one
of four lifecycle events (**checkpoint reached**, **escalation raised**, **sprint
complete**, **sprint failed**), Raptor POSTs a message to a configured Slack
incoming-webhook so the user can step away and be pinged only when something
actually needs them.

The design is governed by five hard constraints from the spec, each of which maps
to a concrete architectural decision:

| Spec constraint | Architectural response |
|---|---|
| Payload from **persisted state / git**, never agent self-report (AC #2) | Notifier reloads state via `loadSprintState`; payload builder reads only `SprintState` fields + git — it is **never** handed agent stdout. |
| **Pluggable channel** abstraction (AC #4) | `NotificationDriver` interface; `SlackWebhookDriver` is the only impl this sprint. Emission call site depends on the interface, not Slack. |
| **Opt-in / off by default**, byte-for-byte parity (AC #8) | Absent `notifications.slack_webhook_url` ⇒ zero drivers registered ⇒ `dispatchNotifications` is a no-op returning immediately before any I/O. |
| **Best-effort**, never breaks the sprint (AC #9) | The entire notification path is wrapped so no throw, non-2xx, or timeout can propagate into the orchestrator. No circuit-breaker coupling. |
| **Config parsed, not just declared** (AC #6, #7) | `parseNotifications` added to `loadConfig`, mirroring `parseTimeouts`/`parseModels`, with a parsed-vs-declared conformance test. |

**Guiding principle — inert by default, isolated failure.** Like `models` in
Sprint 14, this is an inert-by-default capability: no config ⇒ no code path
diverges from today. Unlike prior features it introduces network egress, so the
send path is fully sandboxed from sprint control flow.

## Components

Five components. Four are new; one is a minimal edit to an existing module.

### 1. `src/config.ts` — config parsing (edit)
- Add `notifications?` to `RaptorConfig`.
- Add `parseNotifications(raw)` helper (type-guarded, field-wise-dropping,
  never-throwing — a structural clone of `parseModels`).
- Wire `notifications: parseNotifications(parsed.notifications)` into the
  `loadConfig` return object.

```ts
notifications?: {
  slack_webhook_url?: string;
};
```

`parseNotifications` returns `undefined` for absent/malformed input, and drops
`slack_webhook_url` field-wise unless it is a non-empty `string`. A `notifications`
value that is a string, array, or null ⇒ `undefined`. `loadConfig` never throws.

### 2. `src/orchestrator/notify.ts` — the notifier (new)
The heart of the feature. Pure orchestration; owns dedup and payload derivation.

- **`NotificationEvent`** — a discriminated union derived from state:
  `"checkpoint" | "escalation" | "complete" | "failed"`.
- **`NotificationPayload`** — `{ event, project, sprint, status, featureSlug?, reason?, resumeCommand? }`.
  Contains **no secret** and **no agent text**.
- **`buildPayload(state): NotificationPayload | null`** — derives the payload
  *exclusively* from `SprintState` (and, where needed, git head via `simple-git`).
  Returns `null` when the current status is not a notifiable event.
- **`buildResumeCommand(state): string | undefined`** — reconstructs the exact
  `resume_sprint` invocation for actionable events (see §API Contracts).
- **`dispatchNotifications(state, driver, opts): Promise<void>`** — the single
  choke point. Computes the event key, checks the dedup marker, sends
  best-effort, records the marker, persists. **Never throws.**

### 3. `src/orchestrator/notify-driver.ts` — channel abstraction + Slack driver (new)
```ts
export interface NotificationDriver {
  readonly name: string;                       // "slack"
  send(payload: NotificationPayload): Promise<void>;  // best-effort; may reject — caller isolates
}

export class SlackWebhookDriver implements NotificationDriver {
  readonly name = "slack";
  constructor(private readonly webhookUrl: string) {}
  async send(payload: NotificationPayload): Promise<void> { /* POST to webhookUrl */ }
}
```
The driver formats the payload into a Slack message body and POSTs it. Adding a
future Discord driver = a new class implementing `NotificationDriver` — **no
change to any emission call site** (AC #4). A factory
`resolveDrivers(config): NotificationDriver[]` returns `[]` when no webhook is
configured (the off-by-default gate lives here).

### 4. `src/tools.ts` + `src/index.ts` — emission seam wiring (edit)
`dispatchNotifications` is invoked at the **tool boundary**: after
`runSprint`/`resumeSprintTool` call the runner and it returns, the tool reloads
the freshly-persisted state and dispatches. This is the single production seam.
`ToolContext` gains a `notificationDrivers: NotificationDriver[]` field, populated
once in `index.ts` `main()` from the already-loaded `config`.

### 5. Emission seam — rationale
**Decision: dispatch at the tool boundary, not sprinkled at each `state.status =`
site.** There are ~20 status-assignment sites across `runner.ts`/`multi-runner.ts`,
but each runner invocation performs an **early return** on the first terminal/park
transition — so exactly **one** notifiable event exists per `run_sprint` /
`resume_sprint` call. Placing the single dispatch at the tool boundary therefore:
- sees exactly one event per invocation (no in-runner fan-out to manage);
- reads **persisted** state (reload from disk) — structurally guaranteeing AC #2;
- keeps `runner.ts`/`multi-runner.ts` untouched except for nothing (zero edits),
  minimizing regression surface on the most-critical module;
- is a clean, testable seam (`dispatchNotifications` is a standalone function).

`dispatchNotifications` is nonetheless exported and independently unit-testable
against a fake driver + hand-built state (the production seam test drives
run/resume end-to-end per AC #12).

## Data Model

### Config (additive)
```jsonc
// ~/.raptor/config.json
{
  "notifications": {
    "slack_webhook_url": "https://hooks.slack.com/services/T.../B.../xxxx"
  }
}
```

### SprintState (additive, optional — backward compatible)
One new optional field records which events have already been notified, providing
the **at-most-once** dedup (AC #11) across runner re-entry:

```ts
interface SprintState {
  // ...existing...
  /**
   * notification-egress (Sprint 16): event keys already notified. Additive &
   * optional — absent in pre-feature state files (loadSprintState defaults to
   * []). NEVER contains the webhook URL or any secret (AC #10).
   */
  notifiedEvents?: string[];
}
```

`loadSprintState` defaults `state.notifiedEvents = state.notifiedEvents ?? []`
alongside the existing backward-compat defaulting block. **No migration** of old
state files (consistent with the Sprint 9/13 no-migration convention).

### Event-key scheme (dedup identity)
| Event | Status | Key |
|---|---|---|
| Checkpoint reached | `paused` | `checkpoint:${checkpoints.length - 1}` (index of the newest pending checkpoint) |
| Escalation raised | `escalated` | `escalated:${currentFeatureSlug ?? ""}:${currentStep}` |
| Sprint complete | `complete` | `complete` |
| Sprint failed | `failed` | `failed` |

Rapid re-`resume_sprint` on a still-parked checkpoint re-computes the **same**
index key ⇒ deduped (AC #11 / edge case). A genuinely new checkpoint pushes a new
`checkpoints[]` entry ⇒ new index ⇒ notifies. Re-reading a terminal `complete`/
`failed` state re-computes the same singleton key ⇒ deduped.

### Payload (in-memory, transient — never persisted, never committed)
```ts
interface NotificationPayload {
  event: "checkpoint" | "escalation" | "complete" | "failed";
  project: string;        // state.project
  sprint: number;         // state.sprint
  status: SprintState["status"];
  featureSlug?: string;   // multi-feature: the actionable feature
  reason?: string;        // checkpoint type / escalationReason + step name (from state, NOT agent text)
  resumeCommand?: string; // actionable events only
}
```

## API Contracts

### `parseNotifications(raw: unknown): { slack_webhook_url?: string } | undefined`
- `undefined | null | non-object | array` → `undefined`.
- `slack_webhook_url` copied only if `typeof === "string" && length > 0`.
- Never throws.

### `resolveDrivers(config: RaptorConfig): NotificationDriver[]`
- No `notifications.slack_webhook_url` → `[]` (off-by-default gate; AC #8).
- Present → `[new SlackWebhookDriver(url)]`.

### `dispatchNotifications(state, drivers, opts): Promise<void>`
```ts
async function dispatchNotifications(
  state: SprintState,
  drivers: NotificationDriver[],
  opts: { projectSlug: string; save?: (s: SprintState) => void }
): Promise<void>
```
- If `drivers.length === 0` → return immediately (no state read, no I/O — parity).
- `buildPayload(state)` → `null` (non-notifiable status) → return.
- Compute event key; if `state.notifiedEvents` includes it → return (dedup).
- For each driver: `await driver.send(payload)` inside a per-driver `try/catch`
  that swallows all errors (best-effort). A timeout bounds each send.
- On at-least-one attempt, append the key to `notifiedEvents` and persist via
  `save` (default `saveSprintState`). **The whole body is additionally wrapped so
  no exception escapes.**

### `buildResumeCommand(state): string | undefined` (AC #3)
`resume_sprint` accepts `{ name, sprint, action: "approve" | "request-changes",
feedback?, feature? }`. The notifier reconstructs the copy-pasteable command:

- **Checkpoint** (`paused`): the user's next action is to approve or request
  changes on the parked checkpoint. Emit:
  `resume_sprint(name="<project>", sprint=<N>, action="approve", feature="<slug>")`
  — with a companion note that `action="request-changes"` + `feedback="…"` is the
  alternative. `feature` is included **only** in multi-feature mode (from the
  newest pending checkpoint's `.feature`).
- **Escalation** (`escalated`): name the blocking feature (`currentFeatureSlug` or
  the escalated feature) and the step, so the command targets the right feature.
- **Complete / failed**: terminal, no resume command (informational payload only).

The exact argument mapping is confirmed against `resumeSprintTool`'s signature
(OQ4) — `name`, `sprint`, `action`, optional `feature`. QA validates the emitted
string maps 1:1 to a real `resume_sprint` call.

### Slack message body (webhook POST)
Plain-text Slack message (`{ "text": "…" }`) — Block Kit is a future nicety
(OQ5), not required. Example (complete):
```
✅ Raptor · myapp · sprint 16 — COMPLETE (feature: notification-egress)
```
Actionable example (escalation):
```
🚨 Raptor · myapp · sprint 16 — ESCALATED
  feature: notification-egress · step 7 (attempts-exhausted)
  Next: resume_sprint(name="myapp", sprint=16, action="approve", feature="notification-egress")
```
The webhook URL never appears in the body (AC #10).

## Non-Functional Requirements

| # | Category | Requirement | Verification |
|---|---|---|---|
| NFR-1 | **Isolation / reliability** | A notification failure (network error, non-2xx, timeout, malformed URL) MUST NOT throw into the orchestrator, alter sprint state, block a checkpoint, or touch the circuit breaker. | Integration test: driver whose `send` rejects → sprint state + return value byte-identical to notifications-off (AC #9, #12d). |
| NFR-2 | **Parity (off by default)** | With no webhook configured, the sprint run path is byte-for-byte identical to pre-feature: no network call, no extra state field written, no new prompt. | Default-off parity test per TEAM.md QA rule 13 — zero driver `send` calls; observable output identical (AC #8, #12e). |
| NFR-3 | **Latency budget** | Each POST is bounded by a **5 s timeout**; total added wall-clock at a lifecycle boundary ≤ 5 s per driver even when the endpoint hangs. Sends are fire-and-observe, not retried. | Unit test with a fake slow driver + timeout assertion. |
| NFR-4 | **At-most-once delivery** | Each lifecycle event notifies at most once across arbitrary runner re-entry. No durable-delivery / at-least-once guarantee (best-effort). | Dedup test: re-invoke resume on a parked checkpoint → exactly one send (AC #11, #12a). |
| NFR-5 | **Secret confidentiality** | The webhook URL is read from config only; never written to sprint state, git, backlog, demo docs, logs, or payload content. | grep-style test asserting the URL string never appears in persisted state / payload / log output (AC #10). |
| NFR-6 | **Truthful payload** | Payload content is a pure function of persisted `SprintState` (+ git); never derived from agent stdout. An agent claiming success while state ≠ `complete` produces no "complete" notification. | Test feeds a divergent agent-report fixture; payload reflects persisted status, not the report (AC #2, #12b). |
| NFR-7 | **No new runtime dependency** | The HTTP POST uses a Node built-in (global `fetch`); no package added to `dependencies`. | `package.json` diff review — no new runtime dep. |
| NFR-8 | **Config robustness** | Any malformed `notifications` value degrades to "no notifications"; `loadConfig` never throws. | `parseNotifications` unit tests over string/array/null/wrong-typed inputs (AC #6, edge cases). |
| NFR-9 | **Non-blocking egress** | The send path never blocks indefinitely and never deadlocks the runner; bounded by NFR-3 timeout and best-effort isolation. | Covered by NFR-1 + NFR-3. |

## Technology Choices

> **⚠️ These choices require user approval before implementation (per Architect
> boundary: "Do NOT adopt new technology without user approval"). The headline
> question is the HTTP client.**

| Concern | Choice | Rationale |
|---|---|---|
| **HTTP client for the webhook POST** | **Node built-in global `fetch`** (Node ≥ 18; repo runs Node 24, target ES2022) with `AbortSignal.timeout(5000)` for the best-effort timeout. | **Zero new dependencies** — honors the codebase's minimal-dep stance (OQ2) and NFR-7. `fetch` is stable in Node 24. Fallback if a `fetch`-free posture is preferred: the built-in `https` module (also zero-dep, slightly more code). **No** third-party client (`axios`, `node-fetch`, `@slack/webhook`). |
| **Channel abstraction** | Plain TS `interface NotificationDriver` + concrete `SlackWebhookDriver`; `resolveDrivers(config)` factory. | Minimal, matches existing plain-TS resolution patterns (`resolveRoleModel`). Future Discord driver slots in with no call-site change (AC #4). |
| **Slack integration surface** | **Incoming webhook only** — POST `{ text }` to the configured URL. | AC #5: no OAuth, no bot token, no Slack Web API, no `@slack/*` SDK. |
| **Config parsing** | `parseNotifications` in `loadConfig`, structural clone of `parseModels`. | Kills the `config-keys-parsed-vs-declared` dead-plumbing class (AC #6, #7). |
| **Emission seam** | Tool boundary (`tools.ts`), reload persisted state, single `dispatchNotifications` call. | One event per invocation; structurally guarantees persisted-state derivation (AC #2); zero edits to `runner.ts`/`multi-runner.ts`. |
| **Dedup mechanism** | Persisted `notifiedEvents: string[]` marker + event-key scheme. | Survives process restarts and runner re-entry (AC #11); additive/optional state, no migration. |
| **Message format** | Plain-text Slack `text` payload. | Readable, meets AC #3; Block Kit deferred (OQ5). |
| **Language / runtime / git / tests** | TypeScript on Node.js; `simple-git` for any git reads; jest/ts-jest colocated unit + `tests/integration/`. | Existing stack — no change. |

### Open questions resolved by this design
- **OQ1 (emission seam & module ownership):** tool boundary; `notify.ts` owns the
  notifier, `notify-driver.ts` owns the abstraction + Slack driver.
- **OQ2 (HTTP client):** Node built-in `fetch`, zero deps — **user approval requested**.
- **OQ3 (dedup):** persisted `notifiedEvents` marker with the event-key scheme above.
- **OQ4 (resume command):** reconstructed from `resumeSprintTool`'s `{name, sprint, action, feature?}` signature.
- **OQ5 (formatting):** plain text.
- **OQ6 (payload source of truth):** `state.status`, `state.checkpoints[]` (newest
  pending), `state.currentFeatureSlug`, `state.features[].status` +
  `deriveSprintStatus` for multi-feature terminal states, and the escalated step's
  `escalationReason`/`name`. Git head read via `simple-git` only if a commit ref is
  wanted; **never** agent stdout.

## Constraints & Patterns

- **Additive & backward-compatible everywhere.** `notifications` config optional;
  `notifiedEvents` state optional with `?? []` defaulting; absent config ⇒
  byte-identical behavior. No breaking changes to `RaptorConfig`, `SprintState`,
  `ToolContext` consumers, or the runner.
- **Zero edits to `runner.ts` / `multi-runner.ts`.** The most safety-critical
  modules are untouched; the seam lives entirely in `tools.ts` + `index.ts` +
  the two new modules. (If a future item wants in-runner emission, the notifier is
  already callable there.)
- **Payload derives from persisted state, never agent self-report** (AC #2). The
  payload builder's only inputs are `SprintState` + `simple-git`. It is never
  passed an agent message. This is the co-scheduled trust guarantee with
  `surface-tool-errors-to-openstory`.
- **Best-effort, fully isolated I/O** (AC #9). Every `send` is wrapped in per-driver
  error suppression; `dispatchNotifications` itself is exception-proof. No retry,
  no queue, no durable outbox, no circuit-breaker coupling.
- **Off by default, byte-for-byte** (AC #8). `resolveDrivers` returns `[]` with no
  webhook; `dispatchNotifications` short-circuits before any state read or I/O.
- **Parse every declared key** (AC #6, #7). `notifications` MUST be parsed in
  `loadConfig`; a parsed-vs-declared conformance test guards against drift.
- **No secret leakage** (AC #10). The URL lives only in config and as the POST
  target. Not in state, git, backlog, demo docs, logs, or payload text.
- **All git operations remain `simple-git`.** No shelling out. No new git writes
  from this feature (it only *reads* state/git for the payload).
- **No new runtime dependency.** `fetch` is built-in (NFR-7).
- **Tests exercise the production seam** (AC #12). Regression tests drive
  `run_sprint`/`resume_sprint` reaching each of the four states with a fake driver
  wired through `ToolContext`; each constraint-guarding test carries a
  RED-verification note (TEAM.md QA rule 12), and the default-off parity test
  carries its own (QA rule 13).

### Out of scope (honored)
Discord driver code; Slack OAuth/bot/Web API/interactive actions; per-project or
per-event routing/filtering; inbound/two-way notifications; backlog-dry "ask for
guidance" prompting; email/SMS/generic-URL drivers; retry/queue/delivery
guarantees. Changing how tools return errors is `surface-tool-errors-to-openstory`
(separate Sprint 16 item) — this spec only *consumes* trustworthy persisted state.
