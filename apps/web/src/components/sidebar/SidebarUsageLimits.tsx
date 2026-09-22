import { memo, useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";

import { useAgentLimits } from "../../lib/agentLimitsState";
import { type LimitWindowDisplay, toLimitAccounts } from "../../lib/agentLimitsView";

/** Countdowns are minute-grained at best, so a slow tick is enough and keeps repaints rare. */
const TICK_MS = 30_000;

function windowClassName(window: LimitWindowDisplay): string {
  if (window.stale) {
    return "text-muted-foreground/40";
  }
  const headroom = 100 - window.usedPercent;
  if (headroom < 5) {
    return "text-destructive";
  }
  if (headroom < 25) {
    return "text-warning";
  }
  return "text-muted-foreground/80";
}

/** Emails are long and the sidebar is not; the full address is in the tooltip. */
function shortLabel(label: string): string {
  const at = label.indexOf("@");
  return at > 0 ? label.slice(0, at) : label;
}

/**
 * Subscription headroom for every account the server knows about — each
 * claude-swap Claude account, ChatGPT/Codex, and Cursor's plan — pinned above
 * Settings so it can be checked without leaving the thread.
 */
export const SidebarUsageLimits = memo(function SidebarUsageLimits() {
  const { data } = useAgentLimits();
  const [nowMillis, setNowMillis] = useState(() => Date.now());
  const accounts = data ? toLimitAccounts(data.providers, nowMillis) : [];
  const hasCountdown = accounts.some((account) =>
    account.windows.some((window) => window.resetsIn !== null),
  );

  useEffect(() => {
    if (!hasCountdown) {
      return;
    }
    const intervalId = setInterval(() => setNowMillis(Date.now()), TICK_MS);
    return () => clearInterval(intervalId);
  }, [hasCountdown]);

  if (accounts.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5 px-2 pb-1 text-[11px] leading-4">
      <Link
        to="/settings/usage"
        className="font-medium text-muted-foreground/60 text-[10px] uppercase tracking-wide hover:text-muted-foreground"
      >
        Limits
      </Link>
      {accounts.map((account) => (
        <div key={account.instanceId} className="flex flex-col" title={account.label}>
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-medium text-foreground/80">
              {shortLabel(account.label)}
            </span>
            {account.detail ? (
              <span className="shrink-0 truncate text-muted-foreground/50">{account.detail}</span>
            ) : null}
          </div>
          {account.windows.length > 0 ? (
            <div className="flex flex-wrap gap-x-3 tabular-nums">
              {account.windows.map((window) => (
                <span key={window.label} className={windowClassName(window)}>
                  {window.label} {Math.round(window.usedPercent)}%
                  {window.resetsIn !== null && !window.stale ? ` · ${window.resetsIn}` : ""}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
});
