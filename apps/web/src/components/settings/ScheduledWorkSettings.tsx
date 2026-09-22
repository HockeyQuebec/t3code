import { AlertTriangleIcon, BatteryLowIcon, ClockIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import type { ScheduledTurn } from "@t3tools/contracts";

import { useCancelScheduledTurn, useScheduledTurns } from "../../lib/scheduledTurnsState";
import { formatCountdown, formatScheduledAt, useCoarseNow } from "../../lib/threadRecovery";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

// The countdown wording is shared with the recovery cards in the thread, so the
// same schedule cannot read as two different times in two places.
export { formatCountdown } from "../../lib/threadRecovery";

/** Pending soonest-first (the next thing to happen leads), then newest-first. */
export function sortScheduledTurns(
  turns: ReadonlyArray<ScheduledTurn>,
): ReadonlyArray<ScheduledTurn> {
  const pending = turns
    .filter((turn) => turn.status === "pending")
    .toSorted((a, b) => new Date(a.runAt).getTime() - new Date(b.runAt).getTime());
  const rest = turns
    .filter((turn) => turn.status !== "pending")
    .toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return [...pending, ...rest];
}

const STATUS_LABELS: Record<ScheduledTurn["status"], string> = {
  pending: "Queued",
  dispatched: "Started",
  failed: "Failed",
  cancelled: "Cancelled",
};

function StatusBadge({ status }: { status: ScheduledTurn["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]",
        status === "failed"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : status === "pending"
            ? "border-border/60 bg-muted/40 text-muted-foreground"
            : "border-border/60 bg-muted/20 text-muted-foreground/70",
      )}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Work that queued itself says where it came from, and the two reasons read
 * very differently: one is waiting out a limit, the other is retrying a run
 * that fell over. Work the user queued needs no label — that one they remember,
 * and so does an origin this build has never heard of.
 */
function OriginBadge({ origin }: { origin: ScheduledTurn["origin"] }) {
  if (origin === "usage-limit") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-amber-700 dark:text-amber-300">
        <BatteryLowIcon className="size-3" />
        Limit resume
      </span>
    );
  }
  if (origin === "auto-retry") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-sky-700 dark:text-sky-300">
        <RotateCcwIcon className="size-3" />
        Auto retry
      </span>
    );
  }
  return null;
}

/** How a row explains itself when nobody queued it by hand. */
function originPrefix(origin: ScheduledTurn["origin"]): string {
  if (origin === "usage-limit") {
    return "Queued automatically after a usage limit • ";
  }
  if (origin === "auto-retry") {
    return "Queued automatically after an unexpected stop • ";
  }
  return "";
}

function ScheduledTurnRow({
  turn,
  nowMillis,
  onCancel,
}: {
  turn: ScheduledTurn;
  nowMillis: number;
  onCancel: (turn: ScheduledTurn) => void;
}) {
  const runAtMillis = new Date(turn.runAt).getTime();

  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">
          {turn.prompt || "(empty prompt)"}
        </div>
        <div className="mt-1 truncate text-xs text-muted-foreground/70">
          {originPrefix(turn.origin)}
          Thread {turn.threadId} • {formatScheduledAt(runAtMillis)}
          {turn.status === "pending" ? ` • ${formatCountdown(runAtMillis, nowMillis)}` : ""}
        </div>
        {turn.status === "failed" && turn.error ? (
          <div className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive">
            <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
            <span>{turn.error}</span>
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <OriginBadge origin={turn.origin} />
        <StatusBadge status={turn.status} />
        {turn.status === "pending" ? (
          <Button size="sm" variant="outline" onClick={() => onCancel(turn)}>
            Cancel
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ScheduledWorkSettings(): ReactNode {
  const scheduledQuery = useScheduledTurns();
  const cancelScheduledTurn = useCancelScheduledTurn();
  const nowMillis = useCoarseNow();
  const [cancelError, setCancelError] = useState<string | null>(null);
  const refresh = scheduledQuery.refresh;

  const handleCancel = useCallback(
    (turn: ScheduledTurn) => {
      setCancelError(null);
      void cancelScheduledTurn({ id: turn.id })
        .then(() => {
          refresh();
        })
        .catch((error: unknown) => {
          setCancelError(error instanceof Error ? error.message : String(error));
        });
    },
    [cancelScheduledTurn, refresh],
  );

  const turns = sortScheduledTurns(scheduledQuery.data?.scheduled ?? []);

  return (
    <SettingsSection
      title="Scheduled work"
      icon={<ClockIcon className="size-4 text-muted-foreground" />}
    >
      {scheduledQuery.error ? (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{scheduledQuery.error}</span>
        </div>
      ) : null}
      {cancelError ? (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{cancelError}</span>
        </div>
      ) : null}
      {turns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-4 py-5">
          <div className="text-sm font-medium text-foreground">Nothing queued</div>
          <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground/70">
            Prompts you send later appear here, along with work that a provider usage limit cut
            short — that gets re-queued for just after the limit resets. They run at their scheduled
            time even if this app is closed, as long as the server is running.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
          <div className="divide-y divide-border/50">
            {turns.map((turn) => (
              <ScheduledTurnRow
                key={turn.id}
                turn={turn}
                nowMillis={nowMillis}
                onCancel={handleCancel}
              />
            ))}
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
