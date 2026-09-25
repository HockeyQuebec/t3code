import type {
  OrchestrationLatestTurn,
  OrchestrationThreadActivity,
  ScheduledTurn,
  ThreadId,
} from "@t3tools/contracts";
import { RotateCcwIcon } from "lucide-react";
import { useCallback, useState } from "react";

import {
  useCancelScheduledTurn,
  useScheduledTurns,
  useUpdateScheduledTurn,
} from "~/lib/scheduledTurnsState";
import {
  collectScheduledActivities,
  findScheduledTurnById,
  scheduledTurnsForThread,
  resolveResumeCandidate,
  resolveScheduledActivityCopy,
  useCoarseNow,
} from "~/lib/threadRecovery";
import { Button } from "../ui/button";
import { ScheduledTurnCard } from "./ScheduledTurnCard";

interface ThreadRecoveryPanelProps {
  readonly threadId: ThreadId;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly isWorking: boolean;
  /** The last thing the user sent, which is what a batch resume re-sends. */
  readonly lastUserMessageText: string | null;
  readonly worktreePath: string | null;
  readonly providerDriverKind: string | null;
  /** Sends a prompt as an ordinary turn, exactly as the composer would. */
  readonly onSendPrompt: (prompt: string) => void | Promise<void>;
}

/**
 * What can still be done about a thread that stopped.
 *
 * Sits above the composer because that is where someone looks after reading a
 * failure: a turn that died offers to carry on, and a resume the server queued
 * without being asked offers to run early or not at all.
 */
export function ThreadRecoveryPanel({
  threadId,
  activities,
  latestTurn,
  isWorking,
  lastUserMessageText,
  worktreePath,
  providerDriverKind,
  onSendPrompt,
}: ThreadRecoveryPanelProps) {
  const scheduledQuery = useScheduledTurns();
  const cancelScheduledTurn = useCancelScheduledTurn();
  const updateScheduledTurn = useUpdateScheduledTurn();
  const nowMillis = useCoarseNow();
  const [busyScheduleId, setBusyScheduleId] = useState<string | null>(null);
  const refresh = scheduledQuery.refresh;

  const resume = resolveResumeCandidate({
    latestTurn,
    isWorking,
    lastUserMessageText,
    worktreePath,
    providerDriverKind,
  });
  const scheduled = scheduledQuery.data?.scheduled ?? [];
  // Only schedules still waiting to run. One that already ran, was cancelled,
  // or was run early is history the timeline already shows; keeping its card
  // here would stack a stale card above the composer on every limit hit.
  // A "send later" from the composer writes no activity, so the pending rows
  // themselves drive the list and an activity only supplies the wording. A
  // thread with no messages yet shows its schedule in the empty state instead.
  const activityById = new Map(
    collectScheduledActivities(activities).map((reference) => [
      reference.scheduledTurnId,
      reference,
    ]),
  );
  const pending =
    lastUserMessageText === null
      ? []
      : scheduledTurnsForThread(scheduled, threadId).filter((turn) => turn.status === "pending");

  const handleRunNow = useCallback(
    async (turn: ScheduledTurn) => {
      setBusyScheduleId(turn.id);
      try {
        // Running early is exactly what the server's dispatcher does — take the
        // row out of the queue, then send its prompt — so the cancel has to win
        // before anything is sent. When it comes back false the schedule
        // already fired, and the turn it started is the one that should stand.
        const cancelled = await cancelScheduledTurn({ id: turn.id });
        refresh();
        if (!cancelled) {
          return;
        }
        await onSendPrompt(turn.prompt);
      } finally {
        setBusyScheduleId(null);
      }
    },
    [cancelScheduledTurn, onSendPrompt, refresh],
  );

  const handleEdit = useCallback(
    async (turn: ScheduledTurn, changes: { readonly prompt?: string; readonly runAt?: string }) => {
      setBusyScheduleId(turn.id);
      try {
        await updateScheduledTurn({ id: turn.id, ...changes });
        refresh();
      } finally {
        setBusyScheduleId(null);
      }
    },
    [refresh, updateScheduledTurn],
  );

  const handleCancel = useCallback(
    async (turn: ScheduledTurn) => {
      setBusyScheduleId(turn.id);
      try {
        await cancelScheduledTurn({ id: turn.id });
        refresh();
      } finally {
        setBusyScheduleId(null);
      }
    },
    [cancelScheduledTurn, refresh],
  );

  if (resume === null && pending.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto mb-2 flex max-w-3xl flex-col gap-2">
      {resume === null ? null : (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/60 bg-card/80 px-4 py-2.5 shadow-sm">
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground">This turn did not finish</div>
            <p className="mt-0.5 text-xs text-muted-foreground/80">
              Resume picks the work back up where it stopped rather than starting over.
            </p>
          </div>
          <Button
            size="xs"
            variant="outline"
            className="shrink-0"
            disabled={isWorking}
            onClick={() => void onSendPrompt(resume.prompt)}
          >
            <RotateCcwIcon className="size-3.5" />
            Resume
          </Button>
        </div>
      )}
      {pending.map((turn) => {
        const reference = activityById.get(turn.id);
        const copy = resolveScheduledActivityCopy({
          kind: reference?.kind ?? null,
          origin: turn.origin,
          summary: reference?.summary ?? null,
        });
        const busy = busyScheduleId === turn.id || isWorking;
        return (
          <ScheduledTurnCard
            key={turn.id}
            turn={turn}
            title={copy.title}
            reason={copy.reason}
            nowMillis={nowMillis}
            busy={busy}
            onRunNow={() => void handleRunNow(turn)}
            onEdit={(changes) => handleEdit(turn, changes)}
            onCancel={() => void handleCancel(turn)}
          />
        );
      })}
    </div>
  );
}
