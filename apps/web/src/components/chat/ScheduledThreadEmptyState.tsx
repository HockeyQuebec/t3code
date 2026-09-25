import type { ScheduledTurn, ThreadId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { newCommandId } from "~/lib/utils";
import {
  useCancelScheduledTurn,
  useUpdateScheduledTurn,
  useScheduledTurns,
  useScheduleTurn,
} from "~/lib/scheduledTurnsState";
import {
  resolveScheduledActivityCopy,
  scheduledTurnsForThread,
  useCoarseNow,
} from "~/lib/threadRecovery";
import { TIMELINE_EMPTY_PLACEHOLDER_TEXT } from "./MessagesTimeline.logic";
import { ScheduledTurnCard } from "./ScheduledTurnCard";

interface ScheduledThreadEmptyStateProps {
  readonly threadId: ThreadId;
  /** Sends a prompt as an ordinary turn, exactly as the composer would. */
  readonly onSendPrompt: (prompt: string) => void | Promise<void>;
}

/**
 * The empty state of a thread that was created by a "send later".
 *
 * Scheduling from a draft promotes the thread immediately, so a queued prompt
 * leaves a titled thread with no messages in it. If the schedule is then
 * cancelled — or fails — the generic "send a message" placeholder is the only
 * thing left, and it hides both what was going to be sent and what became of
 * it. The row is still there, so the thread can say so and offer it back.
 */
export function ScheduledThreadEmptyState({
  threadId,
  onSendPrompt,
}: ScheduledThreadEmptyStateProps) {
  const scheduledQuery = useScheduledTurns();
  const cancelScheduledTurn = useCancelScheduledTurn();
  const updateScheduledTurn = useUpdateScheduledTurn();
  const scheduleTurn = useScheduleTurn();
  const nowMillis = useCoarseNow();
  const [busy, setBusy] = useState(false);
  const refresh = scheduledQuery.refresh;

  const handleRunNow = useCallback(
    async (turn: ScheduledTurn) => {
      setBusy(true);
      try {
        // The same two steps the server's dispatcher takes, in the same order:
        // a cancel that comes back false means it already fired, and the turn
        // it started is the one that should stand.
        const cancelled = await cancelScheduledTurn({ id: turn.id });
        refresh();
        if (!cancelled) {
          return;
        }
        await onSendPrompt(turn.prompt);
      } finally {
        setBusy(false);
      }
    },
    [cancelScheduledTurn, onSendPrompt, refresh],
  );

  const handleCancel = useCallback(
    async (turn: ScheduledTurn) => {
      setBusy(true);
      try {
        await cancelScheduledTurn({ id: turn.id });
        refresh();
      } finally {
        setBusy(false);
      }
    },
    [cancelScheduledTurn, refresh],
  );

  const handleReschedule = useCallback(
    async (turn: ScheduledTurn, runAtIso: string) => {
      setBusy(true);
      try {
        await scheduleTurn({
          threadId: turn.threadId,
          prompt: turn.prompt,
          ...(turn.modelSelection ? { modelSelection: turn.modelSelection } : {}),
          // Already an absolute instant from the picker, so it is passed
          // through rather than reparsed against the viewer's zone.
          runAt: runAtIso,
          commandId: newCommandId(),
        });
        refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh, scheduleTurn],
  );

  const turn = scheduledTurnsForThread(scheduledQuery.data?.scheduled ?? [], threadId)[0] ?? null;
  if (turn === null) {
    return <p className="text-sm text-muted-foreground/30">{TIMELINE_EMPTY_PLACEHOLDER_TEXT}</p>;
  }

  const copy = resolveScheduledActivityCopy({ origin: turn.origin, summary: null });
  return (
    <ScheduledTurnCard
      className="w-full max-w-md"
      turn={turn}
      title={turn.status === "pending" ? copy.title : "Nothing was sent"}
      reason={
        turn.status === "pending"
          ? copy.reason
          : "This thread was created for a prompt that was queued to send later."
      }
      nowMillis={nowMillis}
      busy={busy}
      onRunNow={() => void handleRunNow(turn)}
      onCancel={() => void handleCancel(turn)}
      onSendNow={() => void onSendPrompt(turn.prompt)}
      onReschedule={(runAtIso) => handleReschedule(turn, runAtIso)}
      onEdit={async (changes) => {
        setBusy(true);
        try {
          await updateScheduledTurn({ id: turn.id, ...changes });
          refresh();
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
