import type { EnvironmentId, OrchestrationShellSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMenuBarState, menuBarThreadAction, parseMenuBarThreadAction } from "./menuBar.logic";

type Thread = OrchestrationShellSnapshot["threads"][number];

function thread(id: string, overrides: Record<string, unknown>): Thread {
  return {
    id,
    projectId: "project-1",
    title: `Thread ${id}`,
    latestTurn: null,
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    archivedAt: null,
    updatedAt: "2026-09-22T10:00:00.000Z",
    ...overrides,
  } as unknown as Thread;
}

function snapshot(threads: Thread[]): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [{ id: "project-1", title: "t3code" }],
    threads,
    updatedAt: "2026-09-22T10:00:00.000Z",
  } as unknown as OrchestrationShellSnapshot;
}

const environmentId = "env-1" as EnvironmentId;

describe("buildMenuBarState", () => {
  it("lists threads needing the user first and counts them in the title", () => {
    const state = buildMenuBarState({
      environments: [
        {
          environmentId,
          snapshot: snapshot([
            thread("a", { session: { status: "running" } }),
            thread("b", { hasPendingApprovals: true }),
            thread("c", { session: { status: "error" } }),
            thread("d", { hasPendingApprovals: true, archivedAt: "2026-09-22T09:00:00.000Z" }),
          ]),
        },
      ],
      limits: [],
      title: "counts",
      sections: ["working"],
    });

    expect(state.title).toBe("!2 ↻1");
    expect(state.attention).toBe(true);
    expect(state.sections.map((section) => section.label)).toEqual(["Needs you", "Working"]);
    expect(state.sections[0]!.items.map((item) => item.label)).toEqual([
      "Approval: Thread b — t3code",
      "Failed: Thread c — t3code",
    ]);
  });

  it("orders recently finished threads by completion and hides unselected sections", () => {
    const completed = (completedAt: string) => ({
      latestTurn: { state: "completed", completedAt },
    });
    const state = buildMenuBarState({
      environments: [
        {
          environmentId,
          snapshot: snapshot([
            thread("old", completed("2026-09-22T08:00:00.000Z")),
            thread("new", completed("2026-09-22T09:00:00.000Z")),
          ]),
        },
      ],
      limits: [],
      title: "icon",
      sections: ["finished"],
    });

    expect(state.title).toBe("");
    expect(state.attention).toBe(false);
    expect(state.sections).toEqual([
      {
        label: "Recently finished",
        items: [
          { label: "Thread new — t3code", action: menuBarThreadAction(environmentId, "new") },
          { label: "Thread old — t3code", action: menuBarThreadAction(environmentId, "old") },
        ],
      },
    ]);
  });

  it("shows the fullest live limit window, ignoring stale readings", () => {
    const state = buildMenuBarState({
      environments: [],
      limits: [
        {
          instanceId: "claude",
          label: "Claude",
          detail: null,
          level: "normal",
          windows: [
            { label: "5h", usedPercent: 42.4, resetsIn: "2h", stale: false },
            { label: "7d", usedPercent: 95, resetsIn: "now", stale: true },
          ],
        },
      ],
      title: "limits",
      sections: ["limits"],
    });

    expect(state.title).toBe("42%");
    expect(state.sections[0]!.items[0]!.label).toBe("Claude: 5h 42% (2h)");
  });
});

describe("parseMenuBarThreadAction", () => {
  it("round-trips thread actions and rejects anything else", () => {
    expect(parseMenuBarThreadAction(menuBarThreadAction("env-1", "thread-1"))).toEqual({
      environmentId: "env-1",
      threadId: "thread-1",
    });
    expect(parseMenuBarThreadAction("open-settings")).toBeNull();
    expect(parseMenuBarThreadAction("menu-bar:open-thread:env/thread/extra")).toBeNull();
  });
});
