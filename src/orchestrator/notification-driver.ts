/**
 * notification-egress (Sprint 16) — channel abstraction + shipping sink driver.
 *
 * Architecture: docs/architecture/notification-egress.md (v2 REDESIGN — local
 * append-only JSONL sink, ZERO network egress).
 *
 * The `NotificationDriver` interface is the pluggable channel abstraction (AC #4):
 * the emission choke point (`emitNotification`) depends only on this interface, so a
 * future Discord / OpenStory-publisher driver slots in with NO change to any
 * emission call site. The one concrete driver shipping this sprint is
 * `JsonlSinkDriver`, which appends one JSON line per event to a durable local sink.
 *
 * Raptor performs NO outbound network I/O — the redesign's hard constraint. All
 * notification output is a local `fs` append; any future network delivery lives in
 * an out-of-process watcher, never in the Raptor server process.
 */

import * as fs from "fs";
import * as path from "path";
import type { RaptorConfig } from "../config";
import type { NotificationEvent } from "./notifications";

/**
 * Pluggable delivery channel. `send` is best-effort and MAY throw — the caller
 * (`emitNotification`) isolates each driver so a throw never breaks the sprint
 * (AC #9). Implementations must derive their output solely from the passed-in,
 * state-derived `NotificationEvent` (no secret, no agent stdout — AC #10).
 */
export interface NotificationDriver {
  readonly name: string;
  send(event: NotificationEvent): void | Promise<void>;
}

/**
 * The shipping concrete driver: append one JSON line per event to a durable,
 * append-only local sink at `~/.raptor/{slug}/notifications.jsonl` (or an override).
 * Crash-safe single-line appends; prior lines are never rewritten (NFR-9).
 */
export class JsonlSinkDriver implements NotificationDriver {
  readonly name = "jsonl-sink";

  constructor(private readonly sinkPath: string) {}

  send(event: NotificationEvent): void {
    fs.mkdirSync(path.dirname(this.sinkPath), { recursive: true });
    // One event = one single-line JSON append (JSONL). Never a network call.
    fs.appendFileSync(this.sinkPath, JSON.stringify(event) + "\n");
  }
}

/**
 * Resolve the active drivers for a sprint (AC #4 / AC #8 hard off-switch).
 *
 * - `notifications.enabled === false` → `[]` (the off-switch; byte-for-byte
 *   pre-feature parity — no driver, no I/O, no state mutation).
 * - otherwise → a single default-on `JsonlSinkDriver` (the local audit-trail sink).
 *
 * The off-switch lives HERE (not in `emitNotification`) so the parity guarantee is
 * a single, testable factory decision.
 */
export function resolveDrivers(
  config: RaptorConfig,
  sinkPath: string
): NotificationDriver[] {
  if (config.notifications?.enabled === false) {
    return [];
  }
  return [new JsonlSinkDriver(sinkPath)];
}
