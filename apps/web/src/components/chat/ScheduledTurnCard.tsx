import type { ScheduledTurn } from "@t3tools/contracts";
import { AlarmClockIcon, AlertTriangleIcon } from "lucide-react";
import { useState } from "react";

import {
  describeScheduledTurnState,
  formatCountdown,
  formatScheduledAt,
  resolveScheduledTurnActions,
} from "~/lib/threadRecovery";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SendLaterMenu } from "./SendLaterMenu";

interface ScheduledTurnCardProps {
  /** The schedule itself, or null when this client can no longer find the row. */
  readonly turn: ScheduledTurn | null;
  readonly title: string;
  readonly reason: string;
  /**
   * The due time as the announcing activity recorded it, used when the row
   * itself is gone so the card can still say when it was meant to happen.
   */
  readonly fallbackRunAt?: string | null;
  readonly nowMillis: number;
  /** True while one of the actions is in flight, or while the thread is busy. */
  readonly busy?: boolean;
  readonly onRunNow?: (() => void) | undefined;
  readonly onCancel?: (() => void) | undefined;
  readonly onSendNow?: (() => void) | undefined;
  readonly onReschedule?: ((runAtIso: string) => void | Promise<void>) | undefined;
  /** Changes a pending schedule in place. */
  readonly onEdit?:
    | ((changes: { readonly prompt?: string; readonly runAt?: string }) => void | Promise<void>)
    | undefined;
  readonly className?: string;
}

/**
 * One scheduled turn, with whatever can still be done to it.
 *
 * Used both for a resume the server queued mid-thread and for the "send later"
 * that left an otherwise empty thread behind, because in both cases the reader
 * is asking the same two questions: what was going to be sent, and when.
 */
export function ScheduledTurnCard({
  turn,
  title,
  reason,
  fallbackRunAt = null,
  nowMillis,
  busy = false,
  onRunNow,
  onCancel,
  onSendNow,
  onReschedule,
  onEdit,
  className,
}: ScheduledTurnCardProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const runAt = turn?.runAt ?? fallbackRunAt;
  const runAtMillis = runAt === null ? Number.NaN : Date.parse(runAt);
  const hasRunAt = Number.isFinite(runAtMillis);
  const actions = resolveScheduledTurnActions(turn?.status ?? null);
  const note = describeScheduledTurnState(turn);
  const isPending = turn?.status === "pending";

  const runNow = actions.includes("run-now") ? onRunNow : undefined;
  const cancel = actions.includes("cancel") ? onCancel : undefined;
  const sendNow = actions.includes("send-now") ? onSendNow : undefined;
  const reschedule = actions.includes("reschedule") ? onReschedule : undefined;
  const editable = actions.includes("edit") ? onEdit : undefined;
  const editing = draft !== null && editable !== undefined;
  const saveDraft = () => {
    const prompt = draft?.trim() ?? "";
    if (editable === undefined || prompt.length === 0) return;
    if (prompt !== turn?.prompt) void editable({ prompt });
    setDraft(null);
  };
  const hasActions =
    editable !== undefined ||
    runNow !== undefined ||
    cancel !== undefined ||
    sendNow !== undefined ||
    reschedule !== undefined;

  return (
    <div
      className={cn(
        "rounded-2xl border border-border/60 bg-card/80 px-4 py-3 text-left shadow-sm",
        className,
      )}
      data-scheduled-turn-card="true"
    >
      <div className="flex items-start gap-2">
        <AlarmClockIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">{reason}</p>
          {editing ? (
            <div className="mt-2 flex flex-col gap-2">
              <Textarea
                aria-label="Scheduled message"
                value={draft}
                autoFocus
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) saveDraft();
                  if (event.key === "Escape") setDraft(null);
                }}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || draft.trim().length === 0}
                  onClick={saveDraft}
                >
                  Save
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setDraft(null)}>
                  Discard
                </Button>
              </div>
            </div>
          ) : turn && turn.prompt.trim().length > 0 ? (
            <p className="mt-2 line-clamp-3 rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs text-foreground/90">
              {turn.prompt}
            </p>
          ) : null}
          <div className="mt-2 text-xs text-muted-foreground/70">
            {hasRunAt ? formatScheduledAt(runAtMillis) : "No scheduled time recorded"}
            {hasRunAt && isPending ? ` • ${formatCountdown(runAtMillis, nowMillis)}` : ""}
          </div>
          {note !== null ? (
            <div
              className={cn(
                "mt-2 flex items-start gap-1.5 text-xs",
                turn?.status === "failed" ? "text-destructive" : "text-muted-foreground/70",
              )}
            >
              {turn?.status === "failed" ? (
                <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
              ) : null}
              <span>{note}</span>
            </div>
          ) : null}
          {hasActions && !editing ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {runNow ? (
                <Button size="xs" variant="outline" disabled={busy} onClick={runNow}>
                  Run now
                </Button>
              ) : null}
              {sendNow ? (
                <Button size="xs" variant="outline" disabled={busy} onClick={sendNow}>
                  Send it now
                </Button>
              ) : null}
              {editable && turn ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setDraft(turn.prompt)}
                >
                  Edit message
                </Button>
              ) : null}
              {editable ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground/70">
                  Change time
                  <SendLaterMenu disabled={busy} onSchedule={(runAt) => editable({ runAt })} />
                </span>
              ) : null}
              {cancel ? (
                <Button size="xs" variant="ghost" disabled={busy} onClick={cancel}>
                  Cancel
                </Button>
              ) : null}
              {reschedule ? (
                <span className="flex items-center gap-1 text-xs text-muted-foreground/70">
                  Reschedule
                  <SendLaterMenu disabled={busy} onSchedule={reschedule} />
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
