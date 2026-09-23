import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, OrchestrationShellSnapshot, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { useAgentLimits } from "../lib/agentLimitsState";
import { toLimitAccounts } from "../lib/agentLimitsView";
import {
  buildMenuBarState,
  MENU_BAR_OPEN_SETTINGS_ACTION,
  MENU_BAR_OPEN_USAGE_ACTION,
  parseMenuBarThreadAction,
} from "../menuBar.logic";
import { useEnvironments } from "../state/environments";
import { environmentShell } from "../state/shell";

/** Pushes coalesce so a streaming turn does not rebuild the native menu per event. */
const PUSH_DELAY_MS = 500;
/** Limit countdowns are minute-grained; a slow tick keeps them honest. */
const LIMITS_TICK_MS = 60_000;

/**
 * Feeds the desktop menu bar item. Renders nothing; each environment reports
 * its shell snapshot up, and the combined state is pushed to the main process
 * only when it actually changes.
 */
export function MenuBarCoordinator() {
  const bridge = window.desktopBridge;
  const supported =
    typeof bridge?.setMenuBarState === "function" && bridge.getClientPlatform?.() === "darwin";
  const hydrated = useClientSettingsHydrated();
  const enabled = useClientSettings((settings) => settings.menuBarEnabled);
  if (!supported || !hydrated) return null;
  return enabled ? <MenuBarPublisher /> : <MenuBarRemover />;
}

function MenuBarRemover() {
  useEffect(() => {
    void window.desktopBridge?.setMenuBarState?.(null).catch(() => undefined);
  }, []);
  return null;
}

function MenuBarPublisher() {
  const { environments } = useEnvironments();
  const title = useClientSettings((settings) => settings.menuBarTitle);
  const sections = useClientSettings((settings) => settings.menuBarSections);
  const wantsLimits =
    sections.includes("limits") || title === "limits" || title === "counts-and-limits";
  const [snapshots, setSnapshots] = useState(
    () => new Map<EnvironmentId, OrchestrationShellSnapshot>(),
  );
  const [nowMillis, setNowMillis] = useState(() => Date.now());
  const navigate = useNavigate();

  const report = useCallback(
    (environmentId: EnvironmentId, snapshot: OrchestrationShellSnapshot | null) => {
      setSnapshots((current) => {
        if ((current.get(environmentId) ?? null) === snapshot) return current;
        const next = new Map(current);
        if (snapshot) next.set(environmentId, snapshot);
        else next.delete(environmentId);
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    if (!wantsLimits) return;
    const intervalId = setInterval(() => setNowMillis(Date.now()), LIMITS_TICK_MS);
    return () => clearInterval(intervalId);
  }, [wantsLimits]);

  const limitsData = useAgentLimits().data;
  const state = useMemo(
    () =>
      buildMenuBarState({
        environments: environments.flatMap(({ environmentId }) => {
          const snapshot = snapshots.get(environmentId);
          return snapshot ? [{ environmentId, snapshot }] : [];
        }),
        limits: wantsLimits && limitsData ? toLimitAccounts(limitsData.providers, nowMillis) : [],
        title,
        sections,
      }),
    [environments, limitsData, nowMillis, sections, snapshots, title, wantsLimits],
  );

  const serialized = useMemo(() => JSON.stringify(state), [state]);
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      void window.desktopBridge?.setMenuBarState?.(state).catch(() => undefined);
    }, PUSH_DELAY_MS);
    return () => clearTimeout(timeoutId);
    // `serialized` stands in for `state`: identical contents must not re-push.
  }, [serialized]);

  useEffect(
    () => () => void window.desktopBridge?.setMenuBarState?.(null).catch(() => undefined),
    [],
  );

  useEffect(() => {
    const unsubscribe = window.desktopBridge?.onMenuAction((action) => {
      if (action === MENU_BAR_OPEN_SETTINGS_ACTION) {
        void navigate({ to: "/settings/general" });
        return;
      }
      if (action === MENU_BAR_OPEN_USAGE_ACTION) {
        void navigate({ to: "/usage" });
        return;
      }
      const target = parseMenuBarThreadAction(action);
      if (!target) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: target.environmentId as EnvironmentId,
          threadId: target.threadId as ThreadId,
        },
      });
    });
    return () => unsubscribe?.();
  }, [navigate]);

  return environments.map(({ environmentId }) => (
    <EnvironmentSnapshotReporter
      key={environmentId}
      environmentId={environmentId}
      report={report}
    />
  ));
}

function EnvironmentSnapshotReporter({
  environmentId,
  report,
}: {
  environmentId: EnvironmentId;
  report: (environmentId: EnvironmentId, snapshot: OrchestrationShellSnapshot | null) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const snapshot = Option.getOrNull(shell.snapshot);
  useEffect(() => report(environmentId, snapshot), [environmentId, report, snapshot]);
  useEffect(() => () => report(environmentId, null), [environmentId, report]);
  return null;
}
