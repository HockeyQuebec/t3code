import type {
  DesktopMenuBarState,
  EnvironmentId,
  OrchestrationShellSnapshot,
} from "@t3tools/contracts";
import type { MenuBarSection, MenuBarTitle } from "@t3tools/contracts/settings";

import { resolveSidebarThreadStatus } from "./components/Sidebar.logic";
import type { LimitAccountDisplay } from "./lib/agentLimitsView";

const MAX_THREADS_PER_SECTION = 6;
const MAX_LABEL_LENGTH = 60;

export const MENU_BAR_OPEN_THREAD_PREFIX = "menu-bar:open-thread:";
export const MENU_BAR_OPEN_USAGE_ACTION = "menu-bar:open-usage";
export const MENU_BAR_OPEN_SETTINGS_ACTION = "open-menu-bar-settings";

export interface MenuBarEnvironment {
  readonly environmentId: EnvironmentId;
  readonly snapshot: OrchestrationShellSnapshot;
}

export interface MenuBarInput {
  readonly environments: ReadonlyArray<MenuBarEnvironment>;
  readonly limits: ReadonlyArray<LimitAccountDisplay>;
  readonly title: MenuBarTitle;
  readonly sections: ReadonlyArray<MenuBarSection>;
}

const ATTENTION_LABELS = {
  approval: "Approval",
  input: "Input",
  failed: "Failed",
} as const;

function truncate(text: string): string {
  return text.length > MAX_LABEL_LENGTH ? `${text.slice(0, MAX_LABEL_LENGTH - 1)}…` : text;
}

export function menuBarThreadAction(environmentId: string, threadId: string): string {
  return `${MENU_BAR_OPEN_THREAD_PREFIX}${environmentId}/${threadId}`;
}

export function parseMenuBarThreadAction(
  action: string,
): { environmentId: string; threadId: string } | null {
  if (!action.startsWith(MENU_BAR_OPEN_THREAD_PREFIX)) return null;
  const [environmentId, threadId, ...rest] = action
    .slice(MENU_BAR_OPEN_THREAD_PREFIX.length)
    .split("/");
  if (!environmentId || !threadId || rest.length > 0) return null;
  return { environmentId, threadId };
}

/**
 * Everything the desktop menu bar item shows, derived from the same shell
 * snapshots and status rules as the sidebar so the two never disagree.
 */
export function buildMenuBarState(input: MenuBarInput): DesktopMenuBarState {
  type Row = { label: string; action: string; sortKey: number };
  const attention: Array<Row & { rank: number }> = [];
  const working: Row[] = [];
  const finished: Row[] = [];

  for (const { environmentId, snapshot } of input.environments) {
    const projectTitles = new Map(snapshot.projects.map((project) => [project.id, project.title]));
    for (const thread of snapshot.threads) {
      if (thread.archivedAt !== null) continue;
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestTurn?.state === "error") status = "failed";
      const project = projectTitles.get(thread.projectId);
      const name = truncate(project ? `${thread.title} — ${project}` : thread.title);
      const action = menuBarThreadAction(environmentId, thread.id);
      const updatedAt = Date.parse(thread.updatedAt) || 0;
      if (status === "approval" || status === "input" || status === "failed") {
        attention.push({
          label: `${ATTENTION_LABELS[status]}: ${name}`,
          action,
          sortKey: updatedAt,
          rank: status === "failed" ? 1 : 0,
        });
      } else if (status === "working" || status === "monitoring") {
        working.push({
          label: status === "monitoring" ? `${name} (monitoring)` : name,
          action,
          sortKey: updatedAt,
        });
      } else if (thread.latestTurn?.state === "completed") {
        const completedAt = Date.parse(thread.latestTurn.completedAt ?? "");
        if (Number.isFinite(completedAt)) {
          finished.push({ label: name, action, sortKey: completedAt });
        }
      }
    }
  }

  const newestFirst = (left: Row, right: Row) => right.sortKey - left.sortKey;
  attention.sort((left, right) => left.rank - right.rank || newestFirst(left, right));
  working.sort(newestFirst);
  finished.sort(newestFirst);

  const toItems = (rows: ReadonlyArray<Row>) =>
    rows.slice(0, MAX_THREADS_PER_SECTION).map(({ label, action }) => ({ label, action }));
  const withOverflow = (count: number) => (count > MAX_THREADS_PER_SECTION ? ` (${count})` : "");

  const sections: Array<DesktopMenuBarState["sections"][number]> = [];
  if (attention.length > 0) {
    sections.push({
      label: `Needs you${withOverflow(attention.length)}`,
      items: toItems(attention),
    });
  }
  if (input.sections.includes("working")) {
    sections.push({
      label: `Working${withOverflow(working.length)}`,
      items: working.length > 0 ? toItems(working) : [{ label: "No agents running", action: null }],
    });
  }
  if (input.sections.includes("finished") && finished.length > 0) {
    sections.push({ label: "Recently finished", items: toItems(finished) });
  }

  let tightest: number | null = null;
  const limitItems: Array<DesktopMenuBarState["sections"][number]["items"][number]> = [];
  for (const account of input.limits) {
    const windows: string[] = [];
    for (const window of account.windows) {
      if (window.stale) continue;
      tightest = Math.max(tightest ?? 0, window.usedPercent);
      const reset = window.resetsIn === null ? "" : ` (${window.resetsIn})`;
      windows.push(`${window.label} ${Math.round(window.usedPercent)}%${reset}`);
    }
    const detail = windows.length > 0 ? windows.join(" · ") : (account.detail ?? "No usage data");
    limitItems.push({
      label: truncate(`${account.label}: ${detail}`),
      action: MENU_BAR_OPEN_USAGE_ACTION,
    });
  }
  if (input.sections.includes("limits") && limitItems.length > 0) {
    sections.push({ label: "Usage limits", items: limitItems });
  }

  const titleParts: string[] = [];
  if (input.title === "counts" || input.title === "counts-and-limits") {
    if (attention.length > 0) titleParts.push(`!${attention.length}`);
    if (working.length > 0) titleParts.push(`↻${working.length}`);
  }
  if ((input.title === "limits" || input.title === "counts-and-limits") && tightest !== null) {
    titleParts.push(`${Math.round(tightest)}%`);
  }

  const tooltip = [
    `${working.length} working`,
    ...(attention.length > 0 ? [`${attention.length} need you`] : []),
  ].join(", ");

  return {
    title: titleParts.join(" "),
    attention: attention.length > 0,
    tooltip: `T3 Code: ${tooltip}`,
    sections,
  };
}
