import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

/**
 * Turns queued to start later.
 *
 * A scheduled turn is a `thread.turn.start` held back until its due time. The
 * work is written down now — prompt, model, thread — and dispatched by the
 * server when the clock reaches it, so a queued night of work survives the
 * client disconnecting, the laptop sleeping, and the server restarting.
 */

export const ScheduledTurnId = TrimmedNonEmptyString.pipe(Schema.brand("ScheduledTurnId"));
export type ScheduledTurnId = typeof ScheduledTurnId.Type;

/**
 * `pending` is waiting for its due time; `dispatched` was handed to the
 * orchestration engine; `failed` could not be dispatched and says why;
 * `cancelled` was called off before it ran.
 */
export const ScheduledTurnStatus = Schema.Literals([
  "pending",
  "dispatched",
  "failed",
  "cancelled",
]);
export type ScheduledTurnStatus = typeof ScheduledTurnStatus.Type;

/**
 * Who queued this.
 *
 * `user` is someone choosing to send later. `usage-limit` is the server writing
 * down work a provider cut short, to re-send once the window reopens.
 * `auto-retry` is the server writing down work that fell over for a reason that
 * was nothing to do with the work — a killed process, a dropped socket, a
 * provider having a bad minute — to try again shortly, with a growing gap.
 *
 * The distinction matters because the last two appear without anyone asking:
 * the UI has to be able to say why a turn it never saw queued is sitting there,
 * and "waiting for your limit to reset" and "the run crashed, trying again" are
 * different enough stories that one label could not honestly cover both.
 */
export const ScheduledTurnOrigin = Schema.Literals(["user", "usage-limit", "auto-retry"]);
export type ScheduledTurnOrigin = typeof ScheduledTurnOrigin.Type;

export const ScheduledTurn = Schema.Struct({
  id: ScheduledTurnId,
  threadId: ThreadId,
  /** The prompt to send when it fires. */
  prompt: Schema.String,
  /** Defaulted so rows written before automatic resumes existed still decode. */
  origin: ScheduledTurnOrigin.pipe(Schema.withDecodingDefault(Effect.succeed("user" as const))),
  modelSelection: Schema.optional(ModelSelection),
  /** When it should start. */
  runAt: IsoDateTime,
  status: ScheduledTurnStatus,
  createdAt: IsoDateTime,
  /** When it actually fired, for anything past `pending`. */
  resolvedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  /** Why it failed, when it did. */
  error: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ScheduledTurn = typeof ScheduledTurn.Type;

export const ScheduleTurnInput = Schema.Struct({
  threadId: ThreadId,
  prompt: Schema.String,
  origin: Schema.optional(ScheduledTurnOrigin),
  modelSelection: Schema.optional(ModelSelection),
  runAt: IsoDateTime,
  /** Idempotency key, so a retried request cannot queue the work twice. */
  commandId: CommandId,
});
export type ScheduleTurnInput = typeof ScheduleTurnInput.Type;

export const CancelScheduledTurnInput = Schema.Struct({
  id: ScheduledTurnId,
});
export type CancelScheduledTurnInput = typeof CancelScheduledTurnInput.Type;

export const ScheduledTurnList = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  /** Soonest first. */
  scheduled: Schema.Array(ScheduledTurn),
});
export type ScheduledTurnList = typeof ScheduledTurnList.Type;

export const CancelScheduledTurnResult = Schema.Struct({
  /** False when it had already fired or was already cancelled. */
  cancelled: Schema.Boolean,
});
export type CancelScheduledTurnResult = typeof CancelScheduledTurnResult.Type;
