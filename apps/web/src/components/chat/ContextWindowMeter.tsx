import { Button } from "../ui/button";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";
import type { ThreadId, ThreadUsageSnapshot } from "@t3tools/contracts";
import { useThreadUsage } from "~/lib/agentLimitsState";
import { formatSharePercent, formatTokenCount, formatUsd } from "~/lib/agentLimitsView";
import { composerFloatingLayerProps } from "./composerEventScope";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

/** Whose tokens this chat spent, what they would cost at API rates, and its share of the 5h meter. */
function ThreadUsageDetails({ usage }: { usage: ThreadUsageSnapshot }) {
  const splitAccounts = usage.byAccount.length > 1;
  return (
    <div className="flex flex-col gap-1 border-border/60 border-t pt-2 text-[11px] leading-4">
      <div className="font-medium text-muted-foreground text-xs">This chat</div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-secondary-label">5h used, this window</span>
        <span className="font-medium tabular-nums text-secondary-label">
          {formatSharePercent(usage.windowFiveHourPercent)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-secondary-label">5h used, all time</span>
        <span className="tabular-nums text-secondary-label">
          {formatSharePercent(usage.fiveHourPercent)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-secondary-label">Weekly used</span>
        <span className="tabular-nums text-secondary-label">
          {formatSharePercent(usage.weeklyPercent)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-secondary-label">Cost at API rates</span>
        <span className="font-medium tabular-nums text-secondary-label">
          ~{formatUsd(usage.costUsd)}
        </span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-secondary-label">Tokens ({usage.turns} turns)</span>
        <span className="tabular-nums text-secondary-label">
          {formatTokenCount(usage.tokens.totalTokens)}
        </span>
      </div>
      <div className="text-secondary-label/70 tabular-nums">
        in {formatTokenCount(usage.tokens.inputTokens)} · out{" "}
        {formatTokenCount(usage.tokens.outputTokens)} · cache{" "}
        {formatTokenCount(usage.tokens.cacheReadTokens + usage.tokens.cacheWriteTokens)}
      </div>
      {usage.byAccount.map((account) => (
        <div
          key={account.account}
          className="flex items-center justify-between gap-3 text-secondary-label/80"
        >
          <span className="truncate">{account.label}</span>
          <span className="shrink-0 tabular-nums">
            {splitAccounts ? `~${formatUsd(account.costUsd)} · ` : ""}
            {formatSharePercent(account.windowFiveHourPercent)} of 5h
          </span>
        </div>
      ))}
    </div>
  );
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  threadId?: ThreadId | null | undefined;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const { usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;
  const { data: threadUsage } = useThreadUsage(props.threadId ?? null);
  const hasThreadUsage = threadUsage !== null && threadUsage.turns > 0;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <Button
            size="icon-sm"
            variant="ghost-muted"
            className="h-7 w-auto gap-1 rounded-full px-1 hover:text-muted-foreground data-pressed:text-muted-foreground"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 size-full transform-gpu mx-0!"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke={usageColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
            </span>
            <span className="pr-0.5 text-[11px] tabular-nums text-muted-foreground/80">
              {formatContextWindowTokens(usage.usedTokens)}
              {usage.maxTokens !== null ? (
                <span className="text-muted-foreground/50">
                  /{formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              ) : null}
              {hasThreadUsage && threadUsage.windowFiveHourPercent > 0 ? (
                <span className="text-muted-foreground/50">
                  {" "}
                  · {formatSharePercent(threadUsage.windowFiveHourPercent)}
                </span>
              ) : null}
            </span>
          </Button>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Context Window</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-[11px] tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-[11px] tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {hasThreadUsage ? <ThreadUsageDetails usage={threadUsage} /> : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-[11px] font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-[11px]">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** Holds the meter's footprint while a thread's activities are still loading. */
export function ContextWindowMeterPlaceholder() {
  return <span aria-hidden="true" className="size-7 shrink-0" />;
}
