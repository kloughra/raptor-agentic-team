# BDD scenarios — notification-egress (Sprint 16)
#
# Spec:         docs/specs/notification-egress.md (AC 1–12)
# Architecture: docs/architecture/notification-egress.md (v2 REDESIGN)
#
# IMPORTANT — spec/architecture divergence (flagged to PO):
#   The spec (AC 4/5/6/10) describes a Slack incoming-webhook driver configured
#   via `notifications.slack_webhook_url`, with the webhook URL treated as a
#   secret and outbound HTTP egress. The APPROVED architecture v2 supersedes this:
#   Raptor performs ZERO network egress; the shipping concrete driver is a local
#   append-only JSONL sink (`JsonlSinkDriver` → ~/.raptor/{slug}/notifications.jsonl),
#   configured via `notifications.enabled` / `notifications.sinkPath`; Slack delivery
#   moves to an out-of-process watcher (OUT OF SCOPE this sprint). See the
#   architecture §Spec Deviations table. These scenarios are written against the
#   AUTHORITATIVE architecture design, keeping the UNCHANGED spec ACs (1, 2, 3, 7,
#   11, 12) verbatim in intent.
#
# Every change is additive and backward-compatible: with the hard off-switch
# (`notifications.enabled: false`) a sprint behaves byte-for-byte as today.

Feature: Notification egress — out-of-band sprint lifecycle events
  As a Raptor user who wants to step away while a sprint runs
  I want Raptor to emit a durable, state-derived event at each key lifecycle moment
  So that an out-of-process watcher can notify me and I re-engage only when needed,
  without the payload ever counterfeiting what actually happened.

  # =========================================================================
  # AC 1 — Four notification events fire, and only these four
  # =========================================================================

  Scenario: A reached checkpoint emits exactly one "checkpoint" event (AC 1)
    Given a sprint whose persisted state has status "paused" with a new checkpoint entry
    When the tool boundary reloads the persisted state and dispatches a notification
    Then exactly one notification is sent to the driver
    And the notification event kind is "checkpoint"

  Scenario: A raised escalation emits exactly one "escalation" event (AC 1)
    Given a sprint whose persisted state has status "escalated" for a step
    When the tool boundary reloads the persisted state and dispatches a notification
    Then exactly one notification is sent to the driver
    And the notification event kind is "escalation"

  Scenario: A truthfully-completed sprint emits exactly one "complete" event (AC 1)
    Given a sprint whose persisted state has status "complete"
    When the tool boundary reloads the persisted state and dispatches a notification
    Then exactly one notification is sent to the driver
    And the notification event kind is "complete"

  Scenario: A failed sprint emits exactly one "failed" event (AC 1)
    Given a sprint whose persisted state has status "failed"
    When the tool boundary reloads the persisted state and dispatches a notification
    Then exactly one notification is sent to the driver
    And the notification event kind is "failed"

  Scenario: Ordinary intra-step progress fires no notification (AC 1)
    Given a sprint whose persisted state has status "in-progress"
    When the tool boundary reloads the persisted state and dispatches a notification
    Then no notification is sent to the driver

  # =========================================================================
  # AC 2 — Payload derived from persisted state, never agent self-report
  # =========================================================================

  Scenario: Payload content mirrors persisted state, not a divergent agent report (AC 2)
    Given a sprint whose persisted state has status "escalated"
    And an agent that separately claims the sprint completed successfully
    When a notification is derived at the tool boundary
    Then the event kind is "escalation" and the status is "escalated"
    And no "complete" notification is produced

  Scenario: Sprint number, project, and feature come from persisted state (AC 2)
    Given a sprint whose persisted state records project "myapp", sprint 16, feature "notification-egress"
    When a notification is derived from that persisted state
    Then the notification carries project "myapp" and sprint 16
    And the feature reflects the persisted derived value

  # =========================================================================
  # AC 3 — Actionable payload includes the exact resume_sprint command
  # =========================================================================

  Scenario: A checkpoint notification carries the exact resume_sprint command (AC 3)
    Given a sprint parked at a checkpoint in persisted state
    When a notification is derived for that checkpoint
    Then the notification includes a resume_sprint command naming the project and sprint
    And the command specifies an action the user can copy-paste to re-engage

  Scenario: An escalation notification names the blocking feature in its command (AC 3)
    Given a multi-feature sprint whose persisted state escalated one feature
    When a notification is derived for that escalation
    Then the resume_sprint command targets the escalated feature slug

  Scenario: Terminal events carry no resume command (AC 3)
    Given a sprint whose persisted state has status "complete"
    When a notification is derived
    Then the resume command is null

  # =========================================================================
  # AC 4 — Pluggable channel abstraction (Slack driver superseded by sink)
  # =========================================================================

  Scenario: Delivery goes through a NotificationDriver abstraction, not a hard-coded call (AC 4)
    Given notifications are enabled with the default configuration
    When the drivers are resolved for a sprint
    Then a single driver implementing the NotificationDriver interface is returned
    And the shipping driver is the local jsonl-sink driver

  Scenario: A future driver can be added without touching the emission call site (AC 4)
    Given the emission choke point depends only on the NotificationDriver interface
    When a second driver implementing the interface is supplied
    Then both drivers receive the same derived event
    And the emission call site is unchanged

  # =========================================================================
  # AC 6/7 — Config parsed in loadConfig; no dead plumbing
  # =========================================================================

  Scenario: The notifications key is parsed by loadConfig, not merely declared (AC 6, AC 7)
    Given a config file with a notifications object setting enabled true and a sinkPath
    When loadConfig parses the config
    Then config.notifications.enabled is true
    And config.notifications.sinkPath equals the configured path

  Scenario: A malformed notifications value degrades to unconfigured and never crashes loadConfig (AC 6)
    Given a config where notifications is a string, or its fields have wrong types
    When loadConfig parses the config
    Then loadConfig does not throw
    And no invalid field survives into config.notifications

  # =========================================================================
  # AC 8 — Strictly opt-out via hard off-switch; default-off parity
  # =========================================================================

  Scenario: With notifications disabled the sprint path is byte-for-byte pre-feature (AC 8)
    Given a configuration with notifications.enabled set to false
    When the drivers are resolved and a notification is dispatched
    Then zero drivers are resolved
    And no sink file is created and no notified-events marker is written

  # =========================================================================
  # AC 9 — Notification failure never breaks the sprint
  # =========================================================================

  Scenario: A driver that throws does not disturb sprint state or flow (AC 9)
    Given a driver whose send throws on every event
    When a notification is dispatched at the tool boundary
    Then the dispatch does not throw
    And the persisted sprint state and control flow are unchanged

  # =========================================================================
  # AC 11 — At most one notification per lifecycle event (dedup)
  # =========================================================================

  Scenario: Re-entering an already-notified checkpoint fires no duplicate (AC 11)
    Given a checkpoint notification has already been sent for a parked sprint
    When the runner is re-entered and the same parked checkpoint is re-evaluated
    Then no additional notification is sent for that event

  Scenario: Re-reading a terminal state fires no duplicate (AC 11)
    Given a "complete" notification has already been sent for a sprint
    When the terminal state is re-read and dispatch is attempted again
    Then no additional notification is sent

  Scenario: A genuinely new checkpoint after an approved one does notify (AC 11)
    Given a first checkpoint has been notified and then approved
    When the sprint parks at a second, distinct checkpoint
    Then a new notification is sent for the second checkpoint

  # =========================================================================
  # NFR-5/AC 10 — No secret, no egress in the emitted payload
  # =========================================================================

  Scenario: The emitted event contains no secret and no agent stdout (AC 10, NFR-5)
    Given a notification derived from persisted state
    When the serialized event line is inspected
    Then it contains only state-derived fields
    And it contains no webhook URL, credential, or agent message text

  # =========================================================================
  # NFR-9 — Durable append-only sink integrity
  # =========================================================================

  Scenario: The sink appends one JSON line per event and preserves prior lines (NFR-9)
    Given the jsonl-sink driver has already written one event line
    When a second event is written
    Then the sink file contains two well-formed JSON lines
    And the first line is intact
