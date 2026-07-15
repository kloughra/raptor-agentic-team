---
slug: notification-egress
spec: docs/specs/notification-egress.md
sprint: 16
status: proposed
---
# Notification Egress — Architecture Design

> **Architect:** Anky 🦕 · **Status:** proposed (technology choices await user approval — see §Technology Choices)
>
> **REDESIGN (v2, user tech-approval 2026-07-12).** Raptor must **not** perform
> outbound network egress. The Slack incoming-webhook driver from v1 is **replaced**
> by a **durable, local, append-only event sink**. A separate watcher *outside* the
> Raptor process (the harness/agent, a cron job, or an OpenStory subscriber) reads
> the sink and delivers to Slack via the Slack MCP skill — that delivery is **out of
> scope this sprint**. Raptor's deliverable is: **event emission + durable sink +
> dedup + payload fidelity.** The emission seam, payload-from-persisted-state rule,
> dedup marker, best-effort isolation, resume-command reconstruction, and the
> `NotificationDriver` abstraction all survive from v1 unchanged — only the concrete
> driver and its config change. See **§Spec Deviations** for the AC-by-AC
> reconciliation Petra should fold into the spec at close-out (request-changes here
> only re-runs the architecture step; the spec is already approved, so I record
> deviations rather than editing it).

## Overview

Raptor gains a single, best-effort **notification emission** wired at the **tool
boundary** (`runSprint` / `resumeSprintTool` in `src/tools.ts`). After the
orchestrator returns from a `run_sprint` / `resume_sprint` invocation, the tool
wrapper **reloads the persisted `SprintState` from disk**, derives a structured
`NotificationEvent` **exclusively from that persisted state + git** (never from the
agent's returned message), and hands it to a pluggable `NotificationDriver`. The
one concrete driver shipping this sprint is `JsonlSinkDriver`, which appends a
single JSON line to a durable local sink at `~/.raptor/{slug}/notifications.jsonl`.

The design is governed by hard constraints from the spec + the redesign, each
mapping to a concrete decision:

| Constraint | Architectural response |
|---|---|
| Payload from **persisted state / git**, never agent self-report (AC #2) | Boundary reloads state via `loadSprintState`; the payload builder reads only `SprintState` + git — never agent stdout. |
| **Pluggable channel** abstraction (AC #4, KEPT) | `NotificationDriver` interface; `JsonlSinkDriver` is the shipping impl. Emission call site depends on the interface, not on any concrete sink/channel. |
| **No network egress** (redesign hard constraint) | The concrete driver is a local file append. Raptor makes **zero** outbound network calls; Slack delivery moves to an out-of-process watcher. |
| **Best-effort**, never breaks the sprint (AC #9) | The whole emission path is swallow-all wrapped; no throw / I/O error can propagate into the orchestrator. No circuit-breaker coupling. |
| **One event per invocation**, at-most-once (AC #1, #11) | Single dispatch at the tool boundary; persisted `notifiedEvents` marker + event-key scheme dedups across re-entry. |
| **Config parsed, not just declared** (AC #7) | `parseNotifications` added to `loadConfig`, mirroring `parseTimeouts`/`parseModels`, with a parsed-vs-declared conformance test. |

**Guiding principle — inert-friendly by default, isolated failure.** With no secret
and no egress, the only observable of the default-on sink is a new local file (an
audit trail). A hard off-switch (`notifications.enabled: false`) restores
byte-for-byte pre-feature parity. The emission path is fully sandboxed from sprint
control flow.

## Components

Six components. Five are new; the sixth is a minimal edit to `src/config.ts`. **Zero
edits to `runner.ts` / `multi-runner.ts`.**

### 1. `src/config.ts` — config parsing (edit)
- Add `notifications?` to `RaptorConfig`.
- Add `parseNotifications(raw)` helper (type-guarded, field-wise-dropping,
  never-throwing — a structural clone of `parseModels`).
- Wire `notifications: parseNotifications(parsed.notifications)` into the
  `loadConfig` return object.

```ts
notifications?: {
  enabled?: boolean;    // default TRUE (see §Parity decision)
  sinkPath?: string;    // optional override; default ~/.raptor/{slug}/notifications.jsonl
};
```

`parseNotifications` returns `undefined` for absent/malformed input, keeps `enabled`
only if `typeof === "boolean"`, keeps `sinkPath` only if a non-empty `string`, drops
unknown fields field-wise. A `notifications` value that is a string, array, or null
⇒ `undefined`. `loadConfig` never throws. **No secret is read or stored.**

### 2. `src/orchestrator/notifications.ts` — the notifier (new)
The heart of the feature. Pure orchestration; owns dedup and payload derivation.

- **`NotificationEvent`** — structured envelope (see §Data Model). Discriminated by
  `event: "checkpoint" | "escalation" | "complete" | "failed"`.
- **`deriveNotificationEvent(state, opts): NotificationEvent | null`** — derives the
  event *exclusively* from `SprintState` (+ git head via `simple-git` where wanted,
  + `deriveSprintStatus` for multi-feature). Returns `null` when the status is not
  notifiable (`in-progress`). Pure — no clock, no I/O.
- **`buildResumeCommand(state, event): string | null`** — reconstructs the exact
  `resume_sprint` invocation for actionable events (see §API Contracts). Pure.
- **`emitNotification(state, drivers, opts): Promise<void>`** — the single choke
  point. Computes the event key, checks the dedup marker, sends best-effort, records
  the marker, persists. Stamps `occurredAt`. **Never throws.**

### 3. `src/orchestrator/notification-driver.ts` — channel abstraction + sink driver (new)
```ts
export interface NotificationDriver {
  readonly name: string;                              // "jsonl-sink"
  send(event: NotificationEvent): void | Promise<void>; // best-effort; may throw — caller isolates
}

export class JsonlSinkDriver implements NotificationDriver {
  readonly name = "jsonl-sink";
  constructor(private readonly sinkPath: string) {}
  send(event: NotificationEvent): void {
    fs.mkdirSync(path.dirname(this.sinkPath), { recursive: true });
    fs.appendFileSync(this.sinkPath, JSON.stringify(event) + "\n"); // single-line append
  }
}
```
The driver serializes the event to one JSON line and appends it. Adding a future
**Discord** or **OpenStory-publisher** driver = a new class implementing
`NotificationDriver` — **no change to any emission call site** (AC #4). A factory
`resolveDrivers(config, sinkPath): NotificationDriver[]` returns `[]` when
`notifications.enabled === false` (the hard off-switch lives here), else
`[new JsonlSinkDriver(sinkPath)]`.

### 4. `src/tools.ts` + `src/index.ts` — emission seam wiring (edit)
`emitNotification` is invoked at the **tool boundary**: after
`runSprint`/`resumeSprintTool` call the runner and it returns, the tool reloads the
freshly-persisted state (`loadSprintState`) and dispatches. This is the single
production seam. `ToolContext` gains a `notifications` field (the resolved config +
drivers), populated once in `index.ts` `main()` from the already-loaded `config`.

### 5. Emission seam — rationale
**Decision: dispatch at the tool boundary, not sprinkled at each `state.status =`
site.** There are ~20 status-assignment sites across `runner.ts`/`multi-runner.ts`,
but each runner invocation performs an **early return** on the first terminal/park
transition — so exactly **one** notifiable event exists per `run_sprint` /
`resume_sprint` call. Placing the single dispatch at the tool boundary therefore:
- sees exactly one event per invocation (no in-runner fan-out to manage);
- reads **persisted** state (reload from disk) — structurally guaranteeing AC #2;
- keeps `runner.ts`/`multi-runner.ts` untouched (zero edits), minimizing regression
  surface on the most-critical modules;
- is a clean, testable seam (`emitNotification` is a standalone function).

`emitNotification` is nonetheless exported and independently unit-testable against a
fake driver + hand-built state (the production seam test drives run/resume
end-to-end per AC #12).

### 6. External watcher (OUT OF SCOPE — documented interface only)
A process outside Raptor (harness agent / cron / OpenStory subscriber) tails
`notifications.jsonl` and delivers each event to Slack via the Slack MCP skill. This
sprint ships only the sink; the watcher and its Slack delivery are **future work**.
The JSONL line schema (§Data Model) is the contract between Raptor and the watcher.

## Data Model

### Config (additive)
```jsonc
// ~/.raptor/config.json
{
  "notifications": {
    "enabled": true,                                  // optional; default true
    "sinkPath": "~/.raptor/{slug}/notifications.jsonl" // optional override
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
   * []). Contains only eventKey strings — never a secret, never agent text.
   */
  notifiedEvents?: string[];
}
```

`loadSprintState` defaults `state.notifiedEvents = state.notifiedEvents ?? []`
alongside the existing backward-compat defaulting block. **No migration** of old
state files (consistent with the Sprint 9/13 no-migration convention).

### `NotificationEvent` (the JSONL line schema — Raptor↔watcher contract)
```ts
interface NotificationEvent {
  event: "checkpoint" | "escalation" | "complete" | "failed";
  project: string;             // state.project
  sprint: number;              // state.sprint
  status: SprintState["status"];
  feature: string | null;      // multi-feature: the actionable/derived feature slug
  reason: string | null;       // checkpoint type / escalationReason + step name (from state, NOT agent text)
  resumeCommand: string | null;// actionable events only (AC #3)
  eventKey: string;            // dedup identity (AC #11)
  occurredAt: string | null;   // stamped by emitNotification (not by the pure derivers)
}
```
Contains **no secret** and **no agent stdout**. One event = one JSONL line.

### Event-key scheme (dedup identity)
| Event | Status | Key |
|---|---|---|
| Checkpoint reached | `paused` | `checkpoint:${sprint}:${featurePart}:idx${checkpoints.length - 1}:${type}` |
| Escalation raised | `escalated` | `escalation:${sprint}:${featurePart}:step${currentStep}:${escalationReason}` |
| Sprint complete | `complete` | `complete:${sprint}:sprint:-` |
| Sprint failed | `failed` | `failed:${sprint}:sprint:-` |

`featurePart` = actionable feature slug in multi-feature mode (from the parked
checkpoint's `.feature` / escalated `FeatureState`), else `sprint`. Rapid
re-`resume_sprint` on a still-parked checkpoint re-computes the **same** index key ⇒
deduped (AC #11 / edge case). A genuinely new checkpoint pushes a new
`checkpoints[]` entry ⇒ new index ⇒ notifies. Re-reading a terminal state
re-computes the same singleton key ⇒ deduped.

### Durable sink — `~/.raptor/{slug}/notifications.jsonl`
Append-only JSON Lines, one `NotificationEvent` per line, alongside the existing
`sprint-N.json` files. Rationale: crash-safe single-line appends, trivially tailable
by an external watcher, zero-dep, no schema migration, and naturally shared with the
co-scheduled tool-error surfacing item. Path overridable via `notifications.sinkPath`.

## API Contracts

### `parseNotifications(raw: unknown): { enabled?: boolean; sinkPath?: string } | undefined`
- `undefined | null | non-object | array` → `undefined`.
- `enabled` copied only if `typeof === "boolean"`.
- `sinkPath` copied only if `typeof === "string" && length > 0`.
- Never throws.

### `resolveDrivers(config: RaptorConfig, sinkPath: string): NotificationDriver[]`
- `notifications.enabled === false` → `[]` (hard off-switch; parity gate).
- otherwise → `[new JsonlSinkDriver(sinkPath)]` (default-on audit trail).

### `emitNotification(state, drivers, opts): Promise<void>`
```ts
async function emitNotification(
  state: SprintState,
  drivers: NotificationDriver[],
  opts: { projectSlug: string; occurredAt: string; save?: (s: SprintState) => void }
): Promise<void>
```
- If `drivers.length === 0` → return immediately (no I/O — parity path).
- `deriveNotificationEvent(state, ...)` → `null` (non-notifiable status) → return.
- Compute event key; if `state.notifiedEvents` includes it → return (dedup).
- For each driver: `await driver.send(event)` inside a per-driver `try/catch` that
  swallows all errors (best-effort).
- On a **successful** send, append the key to `notifiedEvents` and persist via `save`
  (default `saveSprintState`). **The whole body is additionally wrapped so no
  exception escapes.** (Marker-after-success is a deliberate trade-off — see OQ3.)

### `buildResumeCommand(state, event): string | null` (AC #3)
`resume_sprint` accepts `{ name, sprint, action: "approve" | "request-changes",
feedback?, feature? }`. The notifier reconstructs the copy-pasteable command:

- **Checkpoint** (`paused`): the user's next action is approve / request-changes on
  the parked checkpoint. Emit:
  `resume_sprint(name="<project>", sprint=<N>, action="approve", feature="<slug>")`
  with a companion note that `action="request-changes"` + `feedback="…"` is the
  alternative. `feature` is included **only** in multi-feature mode (from the newest
  pending checkpoint's `.feature`).
- **Escalation** (`escalated`): name the blocking feature (escalated
  `FeatureState` / `currentFeatureSlug`) and step, so the command targets the right
  feature (multi-feature mixed-terminal edge case).
- **Complete / failed**: terminal → `null` (informational event only; a failed
  sprint's next action is human triage, not a canned resume).

Argument mapping is confirmed against `resumeSprintTool`'s `{name, sprint, action,
feature?}` signature (OQ4). QA validates the emitted string maps 1:1 to a real call.

### Example JSONL lines
```jsonc
// complete
{"event":"complete","project":"myapp","sprint":16,"status":"complete","feature":"notification-egress","reason":null,"resumeCommand":null,"eventKey":"complete:16:sprint:-","occurredAt":"2026-07-12T18:04:00Z"}
// escalation (actionable)
{"event":"escalation","project":"myapp","sprint":16,"status":"escalated","feature":"notification-egress","reason":"step 7 (attempts-exhausted)","resumeCommand":"resume_sprint(name=\"myapp\", sprint=16, action=\"approve\", feature=\"notification-egress\")","eventKey":"escalation:16:notification-egress:step7:attempts-exhausted","occurredAt":"2026-07-12T18:04:00Z"}
```
No secret is present anywhere in the line (nothing secret exists — AC #10 moot).

## Non-Functional Requirements

| # | Category | Requirement | Verification |
|---|---|---|---|
| NFR-1 | **Isolation / reliability** | A sink-write failure (I/O error, permissions, disk full) MUST NOT throw into the orchestrator, alter sprint state, block a checkpoint, or touch the circuit breaker. | Integration test: driver whose `send` throws → sprint state + return value byte-identical to notifications-off (AC #9, #12d). |
| NFR-2 | **Parity (hard off-switch)** | With `notifications.enabled: false`, the sprint run path is byte-for-byte identical to pre-feature: no sink file, no `notifiedEvents` writes, no new prompt. | Default-off parity test per TEAM.md QA rule 13 — zero driver `send` calls; no file created; observable output identical (AC #8, #12e). |
| NFR-3 | **Latency budget** | Emission overhead per `run_sprint`/`resume_sprint` = one `loadSprintState` (a read Raptor already does) + one `fs.appendFileSync` of a sub-1 KB line. Target **< 5 ms**; **no network, ever**. Must not measurably slow a sprint. | Micro-benchmark / unit assertion on the append path. |
| NFR-4 | **At-most-once delivery** | Each lifecycle event notifies at most once across arbitrary runner re-entry. No durable at-least-once guarantee (best-effort). | Dedup test: re-invoke resume on a parked checkpoint → exactly one send (AC #11, #12a). |
| NFR-5 | **No secret / no egress** | Raptor makes **zero** outbound network calls. No secret is read, stored, or emitted; the sink is a local file whose content is state-derived only. | grep-style test asserting no `http(s)` client is invoked and the sink content is pure state-derived data (redesign hard constraint; AC #5/#10 superseded). |
| NFR-6 | **Truthful payload** | Payload is a pure function of persisted `SprintState` (+ git); never derived from agent stdout. An agent claiming success while state ≠ `complete` produces no "complete" event. | Test feeds a divergent agent-report fixture; event reflects persisted status, not the report (AC #2, #12b). |
| NFR-7 | **No new runtime dependency** | Sink I/O uses Node built-in `fs`; no package added to `dependencies`. | `package.json` diff review — no new runtime dep. |
| NFR-8 | **Config robustness / conformance** | Any malformed `notifications` value degrades to defaults; `loadConfig` never throws. `notifications` is actually parsed (parsed-vs-declared conformance). | `parseNotifications` unit tests + conformance test that FAILS against a declare-but-don't-parse `loadConfig` (AC #7). |
| NFR-9 | **Durability** | Sink is append-only JSONL; each event is one atomic single-line append. A crash loses at most the in-flight line, never corrupts prior events. No durable-outbox/retry. | Append-integrity test (existing lines intact after a second append). |

### Parity decision (AC #8): sink on by default, hard off-switch
The spec's strict "byte-for-byte, no observable change when unconfigured" was tied
to a **secret + network egress** default-off requirement. With egress removed the
only residual observable is a local append-only file. Per the redesign's explicit
"decide whether to gate it":

- **Default ON** (no config needed): the sink is written as an audit trail — the
  substrate the autonomy north-star watcher needs, carrying no secret and no network
  risk.
- **Hard off-switch**: `notifications.enabled: false` yields **byte-identical**
  pre-feature behavior (no sink file, no marker) — the literal AC #8 parity
  guarantee, available on demand and covered by the QA-rule-13 parity test.

## Technology Choices

> **⚠️ These choices require user approval before implementation (Architect
> boundary: "Do NOT adopt new technology without user approval"). All choices keep
> Raptor at ZERO new dependencies and ZERO network egress.**

| Concern | Choice | Rationale |
|---|---|---|
| **Sink transport** | **Local append-only JSONL** at `~/.raptor/{slug}/notifications.jsonl` via Node built-in `fs.appendFileSync`. | Zero-dep, no network, no secret, crash-safe appends, tailable by an external watcher. Replaces the v1 HTTP webhook. |
| **HTTP client** | **None** — removed. | Egress eliminated by user decision: no `fetch`/`https`, no POST timeout, no network-failure paths, no secret. |
| **Slack delivery** | **Out of Raptor scope** — external watcher reads the sink and uses the Slack MCP skill. | The Slack MCP skill is callable only by a harness Claude agent, not the Raptor server process; keeping delivery in a watcher lets us use the richer skill while Raptor stays egress-free. |
| **Channel abstraction** | Plain TS `interface NotificationDriver` + concrete `JsonlSinkDriver`; `resolveDrivers` factory. | Minimal, matches existing plain-TS resolution patterns (`resolveRoleModel`). Future Discord / OpenStory-publisher driver slots in with no call-site change (AC #4). |
| **Config parsing** | `parseNotifications` in `loadConfig`, structural clone of `parseModels`. | Kills the `config-keys-parsed-vs-declared` dead-plumbing class (AC #7). |
| **Emission seam** | Tool boundary (`tools.ts`), reload persisted state, single `emitNotification` call. | One event per invocation; structurally guarantees persisted-state derivation (AC #2); zero edits to `runner.ts`/`multi-runner.ts`. |
| **Dedup mechanism** | Persisted `notifiedEvents: string[]` marker + event-key scheme. | Survives process restarts and runner re-entry (AC #11); additive/optional state, no migration. |
| **Event format** | JSON Lines (one `NotificationEvent` per line). | Crash-safe appends, streamable, machine-readable by the watcher; shareable with the tool-error item. |
| **Language / runtime / git / tests** | TypeScript on Node.js; `simple-git` for any git reads; jest/ts-jest colocated unit + `tests/integration/`. | Existing stack — no change. |

### Open questions resolved by this design
- **OQ1 (emission seam & module ownership):** tool boundary;
  `notifications.ts` owns the notifier, `notification-driver.ts` owns the
  abstraction + sink driver.
- **OQ2 (HTTP client):** **N/A** — no HTTP client; egress removed. Sink I/O is Node
  built-in `fs`, zero deps.
- **OQ3 (dedup):** persisted `notifiedEvents` marker with the event-key scheme above.
  Marker is recorded **after a successful send** so a failed local append retries
  next invocation; the only duplicate window is append-succeeds-but-marker-save-fails
  (rare, local-only) — flagged for QA confirmation vs. mark-before-send.
- **OQ4 (resume command):** reconstructed from `resumeSprintTool`'s
  `{name, sprint, action, feature?}` signature.
- **OQ5 (formatting):** structured JSONL (the watcher owns human/Slack formatting).
- **OQ6 (payload source of truth):** `state.status`, `state.checkpoints[]` (newest
  pending), `state.currentFeatureSlug`, `state.features[].status` +
  `deriveSprintStatus` for multi-feature terminal states, and the escalated step's
  `escalationReason`/`name`. Git head via `simple-git` only if a commit ref is
  wanted; **never** agent stdout.

## Constraints & Patterns

- **Egress-free orchestrator (user hard constraint).** Raptor performs **no**
  outbound network I/O. All notification output is a local file write. Any future
  network delivery lives in an out-of-process watcher, never in the Raptor server.
- **Additive & backward-compatible everywhere.** `notifications` config optional;
  `notifiedEvents` state optional with `?? []` defaulting; `enabled:false` ⇒
  byte-identical behavior. No breaking changes to `RaptorConfig`, `SprintState`,
  `ToolContext` consumers, or the runner.
- **Zero edits to `runner.ts` / `multi-runner.ts`.** The seam lives entirely in
  `tools.ts` + `index.ts` + the two new modules. (A future item wanting in-runner
  emission can already call the notifier.)
- **Payload derives from persisted state, never agent self-report** (AC #2). The
  builder's only inputs are `SprintState` + `simple-git`. This is the co-scheduled
  trust guarantee with `surface-tool-errors-to-openstory`.
- **Best-effort, fully isolated I/O** (AC #9). Every `send` is wrapped in per-driver
  error suppression; `emitNotification` itself is exception-proof. No retry, no
  queue, no durable outbox, no circuit-breaker coupling.
- **Pure derive functions, no clock inside them.** `deriveNotificationEvent` /
  `buildResumeCommand` are pure and deterministic (testable without mocking time);
  `occurredAt` is stamped by `emitNotification`, never inside the pure derivers —
  mirrors the deterministic-summary-generation pattern.
- **Parse every declared key** (AC #7). `notifications` MUST be parsed in
  `loadConfig`; a parsed-vs-declared conformance test guards against drift.
- **No secret leakage** (AC #10, now moot). No secret exists; the sink is local and
  its content is state-derived only.
- **All git operations remain `simple-git`.** No shelling out. This feature only
  *reads* state/git for the payload; the only write is the additive `notifiedEvents`
  marker and the local sink line.
- **No new runtime dependency** (NFR-7).
- **Multi-feature status via `deriveSprintStatus`** (mixed-terminal edge case). The
  event's `status`/`feature` come from the persisted derived sprint status, not a
  single feature's self-report.
- **Tests exercise the production seam** (AC #12). Regression tests drive
  `run_sprint`/`resume_sprint` reaching each of the four states with a fake driver
  wired through `ToolContext`; the **sink-append boundary is faked/spied**, not the
  internal `deriveNotificationEvent`. Each constraint-guarding test carries a
  RED-verification note (TEAM.md QA rule 12); the default-off parity test carries its
  own (QA rule 13). Minimum coverage: (a) each of the four events → exactly one send;
  (b) payload matches persisted state, not a divergent agent-report fixture; (c) an
  actionable event's payload contains the exact `resume_sprint` command; (d) a
  failing sink write does not disturb sprint state or flow; (e) `enabled:false` →
  zero sends; (f) re-entry on an already-notified state → zero additional sends.

## Spec Deviations (for Petra to reconcile at close-out)

The user's tech-approval redesign supersedes several spec ACs. Recording them here
explicitly (the spec is already approved; request-changes only re-runs this
architecture step, so I do not edit the spec):

| Spec AC | Original (webhook) | This design (local sink) |
|---|---|---|
| **AC #4** | "channel abstraction; a **Slack incoming-webhook driver** ships" | Abstraction **KEPT**; the shipping concrete driver is **`JsonlSinkDriver`** (local append-only sink), not a Slack driver. |
| **AC #5** | "Slack driver is webhook-only; HTTP POST to webhook URL" | **Removed.** No Slack driver, no HTTP POST, no network in Raptor. Slack delivery moves to an out-of-process watcher (out of scope). |
| **AC #6** | "configured via `notifications.slack_webhook_url`, parsed in `loadConfig`" | **Replaced.** Config is `notifications.enabled` / `notifications.sinkPath`; still parsed in `loadConfig` with a parsed-vs-declared conformance test. The webhook URL key + its parsing/secret handling are gone. |
| **AC #10** | "no secret leakage (webhook URL)" | **Moot.** No secret exists — the sink is a local file; nothing secret is read, stored, or emitted. |
| **AC #8** | "byte-for-byte off by default (no secret configured)" | **Relaxed** (see §Parity decision). Sink is on-by-default audit trail; only observable is a local file. `enabled:false` restores byte-identical parity. |
| **AC #9** | "a failed **POST** never breaks the sprint" | Re-scoped to "a failed **sink write** never breaks the sprint." Best-effort isolation contract unchanged. |
| **AC #12** | "HTTP boundary mocked/faked" | Re-scoped to "**sink-append boundary** faked/spied." Same production-seam requirement, same RED notes. |

**Unchanged from spec:** AC #1 (four events), AC #2 (payload from persisted state),
AC #3 (actionable resume command), AC #7 (parsed-vs-declared conformance), AC #11
(dedup, at most once), AC #12 production-seam testing discipline.

## Synergy — `surface-tool-errors-to-openstory` (co-scheduled)

Both items reduce to "Raptor emits structured events for external observers." The
`NotificationEvent` envelope, `NotificationDriver` interface, and `JsonlSinkDriver`
are intentionally generic so the tool-error item can emit its structured error
events through the **same sink mechanism** (either the same file with an
`event`-kind discriminator, or a sibling `events.jsonl`). Publishing to OpenStory's
event bus specifically (rather than a local file) would require a new integration /
dependency — flagged as **FUTURE**; the zero-dep local JSONL sink is the MVP
substrate for this sprint and satisfies the autonomy north-star's "notify me
out-of-band" via an external watcher. Cross-item coordination on the shared-vs-
sibling sink decision is OQ1 for that item.

## Out of scope (honored)
Discord driver code; the external watcher + Slack MCP delivery; Slack
OAuth/bot/Web API/interactive actions; publishing to OpenStory's event bus (FUTURE);
per-project or per-event routing/filtering; inbound/two-way notifications;
backlog-dry "ask for guidance" prompting; email/SMS/generic-URL/HTTP drivers;
retry/queue/delivery guarantees. Changing how tools return errors is
`surface-tool-errors-to-openstory` (separate Sprint 16 item) — this spec only
*consumes* trustworthy persisted state.
</content>
