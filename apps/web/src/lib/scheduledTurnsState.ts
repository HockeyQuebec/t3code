import type {
  CancelScheduledTurnInput,
  ScheduledTurn,
  ScheduleTurnInput,
  UpdateScheduledTurnInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback } from "react";

import { usePrimaryEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Work queued to start later.
 *
 * The list is a subscription rather than a poll: it only changes when someone
 * queues or cancels something, or when the server fires one.
 */
export function useScheduledTurns() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  return useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.scheduledTurns({ environmentId, input: {} }),
  );
}

export function useScheduleTurn() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const command = useAtomCommand(serverEnvironment.scheduleTurn, { reportFailure: false });

  return useCallback(
    async (input: ScheduleTurnInput): Promise<ScheduledTurn> => {
      if (environmentId === null) {
        throw new Error("No environment is selected.");
      }
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") {
        throw Cause.squash(result.cause);
      }
      return result.value;
    },
    [environmentId, command],
  );
}

/** Changes a pending schedule's prompt or time; false once it has fired. */
export function useUpdateScheduledTurn() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const command = useAtomCommand(serverEnvironment.updateScheduledTurn, { reportFailure: false });

  return useCallback(
    async (input: UpdateScheduledTurnInput): Promise<boolean> => {
      if (environmentId === null) {
        throw new Error("No environment is selected.");
      }
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") {
        throw Cause.squash(result.cause);
      }
      return result.value.updated;
    },
    [environmentId, command],
  );
}

export function useCancelScheduledTurn() {
  const primaryEnvironment = usePrimaryEnvironment();
  const environmentId = primaryEnvironment?.environmentId ?? null;
  const command = useAtomCommand(serverEnvironment.cancelScheduledTurn, { reportFailure: false });

  return useCallback(
    async (input: CancelScheduledTurnInput): Promise<boolean> => {
      if (environmentId === null) {
        throw new Error("No environment is selected.");
      }
      const result = await command({ environmentId, input });
      if (result._tag === "Failure") {
        throw Cause.squash(result.cause);
      }
      return result.value.cancelled;
    },
    [environmentId, command],
  );
}

/** Presets the composer offers, so "tonight" means one thing everywhere. */
export const SEND_LATER_PRESETS = [
  { id: "1h", label: "In 1 hour", minutes: 60 },
  { id: "3h", label: "In 3 hours", minutes: 3 * 60 },
  { id: "tonight", label: "Tonight (10pm)", minutes: null },
  { id: "tomorrow", label: "Tomorrow (9am)", minutes: null },
] as const;

export type SendLaterPresetId = (typeof SEND_LATER_PRESETS)[number]["id"];

/**
 * When a preset means, as epoch milliseconds.
 *
 * The named times are resolved against the viewer's clock and roll forward to
 * the next occurrence, so "tonight" chosen at 11pm means tomorrow night rather
 * than an hour ago.
 */
export function resolvePresetMillis(preset: SendLaterPresetId, nowMillis: number): number {
  const entry = SEND_LATER_PRESETS.find((candidate) => candidate.id === preset);
  if (entry?.minutes != null) {
    return nowMillis + entry.minutes * 60_000;
  }

  const hour = preset === "tonight" ? 22 : 9;
  const target = new Date(nowMillis);
  target.setHours(hour, 0, 0, 0);
  const millis = target.getTime();
  return millis <= nowMillis ? millis + 24 * 60 * 60_000 : millis;
}
