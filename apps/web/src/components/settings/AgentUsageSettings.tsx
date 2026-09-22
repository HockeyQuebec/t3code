import { AlertTriangleIcon, BoltIcon, CreditCardIcon, RefreshCwIcon } from "lucide-react";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { useState, type ReactNode } from "react";
import type {
  AgentLimitsSnapshot,
  HarnessCatalog,
  SpendEntry,
  SpendSummary,
} from "@t3tools/contracts";

import { useAgentLimits, useHarnessCatalog, useSpendSummary } from "../../lib/agentLimitsState";
import { formatSpend, formatUsd, rankLimits } from "../../lib/agentLimitsView";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsSection } from "./settingsLayout";
import { HarnessRoleControls, type HarnessRoleOverrides } from "./HarnessRoleControls";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";

type SpendWindow = "today" | "week" | "month" | "all";

function ProviderLimitsBadge({ levelText, level }: { levelText: string; level: string }) {
  const isWarning = level === "low";
  const isDanger = level === "exhausted" || level === "unknown";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em]",
        isDanger
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : isWarning
            ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
            : "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
      )}
    >
      <span
        className={cn(
          "size-1 rounded-full",
          isDanger ? "bg-destructive" : isWarning ? "bg-amber-500" : "bg-emerald-500",
        )}
      />
      {levelText}
    </span>
  );
}

function ProvidersSection(): ReactNode {
  const limitsQuery = useAgentLimits();
  const nowMs = Date.now();

  if (limitsQuery.isPending) {
    return (
      <SettingsSection
        title="Provider headroom"
        icon={<CreditCardIcon className="size-4 text-muted-foreground" />}
      >
        <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          Loading provider limits...
        </div>
      </SettingsSection>
    );
  }

  if (limitsQuery.error) {
    return (
      <SettingsSection
        title="Provider headroom"
        icon={<CreditCardIcon className="size-4 text-muted-foreground" />}
      >
        <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{limitsQuery.error}</span>
        </div>
      </SettingsSection>
    );
  }

  const snapshot = limitsQuery.data as AgentLimitsSnapshot | null;
  const ranked = snapshot ? rankLimits(snapshot.providers, nowMs) : [];

  const hasData = ranked.length > 0;

  return (
    <SettingsSection
      title="Provider headroom"
      icon={<CreditCardIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-5 rounded-sm p-0"
                disabled={limitsQuery.isPending}
                onClick={limitsQuery.refresh}
                aria-label="Refresh provider limits"
              >
                <RefreshCwIcon className={cn("size-3", limitsQuery.isPending && "animate-spin")} />
              </Button>
            }
          />
          <TooltipPopup side="top">Refresh limits</TooltipPopup>
        </Tooltip>
      }
    >
      {!hasData ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-4 py-5">
          <div className="text-sm font-medium text-foreground">
            Providers report headroom as they run
          </div>
          <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground/70">
            Usage limits will appear here after the first turn with each provider configured.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
          <div className="divide-y divide-border/50">
            {ranked.map((limit) => (
              <div
                key={limit.instanceId}
                className="flex flex-col gap-2 border-border/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-foreground">{limit.label}</div>
                  <div className="mt-1 text-xs text-muted-foreground/70">
                    {limit.windowLabel || "Window unknown"}
                    {limit.resetsIn ? ` • resets in ${limit.resetsIn}` : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  {limit.stale ? (
                    <ProviderLimitsBadge levelText="Stale" level="stale" />
                  ) : (
                    <ProviderLimitsBadge
                      levelText={
                        limit.usedPercent !== null ? `${Math.round(limit.usedPercent)}%` : "Unknown"
                      }
                      level={limit.level}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

function SpendTable({ entries, title }: { entries: ReadonlyArray<SpendEntry>; title: string }) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 overflow-hidden rounded-lg border border-border/60">
      <table className="w-full table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[30%]" />
          <col className="w-[20%]" />
          <col className="w-[20%]" />
          <col className="w-[15%]" />
          <col className="w-[15%]" />
        </colgroup>
        <thead className="border-b border-border/60 bg-muted/40 text-[10px] uppercase tracking-[0.08em] text-muted-foreground/65">
          <tr>
            <th className="px-3 py-2 font-semibold sm:pl-4">{title}</th>
            <th className="px-3 py-2 text-right font-semibold">Tokens</th>
            <th className="px-3 py-2 text-right font-semibold">Reported</th>
            <th className="px-3 py-2 text-right font-semibold">Estimated</th>
            <th className="px-3 py-2 text-right font-semibold sm:pr-4">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/50">
          {entries.map((entry) => (
            <tr key={entry.key} className="hover:bg-muted/20">
              <td className="truncate px-3 py-2 font-medium text-foreground sm:pl-4">
                {entry.key}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {(entry.tokens.totalTokens / 1_000).toFixed(0)}k
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs tabular-nums">
                {formatUsd(entry.reportedCostUsd)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground/70">
                {formatUsd(entry.estimatedCostUsd)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs font-medium tabular-nums sm:pr-4">
                {formatSpend(entry.reportedCostUsd, entry.estimatedCostUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SpendWindowSelector({
  selected,
  onSelect,
}: {
  selected: SpendWindow;
  onSelect: (window: SpendWindow) => void;
}) {
  const windows: ReadonlyArray<{ label: string; value: SpendWindow }> = [
    { label: "Today", value: "today" },
    { label: "Week", value: "week" },
    { label: "Month", value: "month" },
    { label: "All", value: "all" },
  ];

  return (
    <div className="flex items-center rounded-md border border-border/60 p-0.5">
      {windows.map((window) => (
        <button
          key={window.value}
          type="button"
          className={cn(
            "h-6 rounded-sm px-2 text-[11px] font-medium text-muted-foreground hover:text-foreground",
            selected === window.value && "bg-muted text-foreground",
          )}
          onClick={() => onSelect(window.value)}
        >
          {window.label}
        </button>
      ))}
    </div>
  );
}

function SpendSection(): ReactNode {
  const [selectedWindow, setSelectedWindow] = useState<SpendWindow>("today");
  const spendQuery = useSpendSummary({ window: selectedWindow });

  if (spendQuery.isPending) {
    return (
      <SettingsSection
        title="Token spend"
        icon={<CreditCardIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <SpendWindowSelector selected={selectedWindow} onSelect={setSelectedWindow} />
        }
      >
        <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          Loading spend data...
        </div>
      </SettingsSection>
    );
  }

  if (spendQuery.error) {
    return (
      <SettingsSection
        title="Token spend"
        icon={<CreditCardIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <SpendWindowSelector selected={selectedWindow} onSelect={setSelectedWindow} />
        }
      >
        <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{spendQuery.error}</span>
        </div>
      </SettingsSection>
    );
  }

  const data = spendQuery.data as SpendSummary | null;

  return (
    <SettingsSection
      title="Token spend"
      icon={<CreditCardIcon className="size-4 text-muted-foreground" />}
      headerAction={
        <div className="flex items-center gap-2">
          <SpendWindowSelector selected={selectedWindow} onSelect={setSelectedWindow} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="size-5 rounded-sm p-0"
                  disabled={spendQuery.isPending}
                  onClick={spendQuery.refresh}
                  aria-label="Refresh spend data"
                >
                  <RefreshCwIcon className={cn("size-3", spendQuery.isPending && "animate-spin")} />
                </Button>
              }
            />
            <TooltipPopup side="top">Refresh spend</TooltipPopup>
          </Tooltip>
        </div>
      }
    >
      <div className="space-y-4">
        {data && data.truncated ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-xs text-amber-700 dark:text-amber-300">
            This ledger covers work since the server started. Totals are partial until the full
            window is available.
          </div>
        ) : null}

        {data ? (
          <div className="rounded-xl border border-border/60 bg-card px-4 py-4 sm:px-5">
            <div className="text-[10px] font-semibold uppercase tracking-[0.11em] text-muted-foreground/70">
              Total
            </div>
            <div className="mt-3 text-2xl font-semibold tracking-[-0.05em] text-foreground">
              {formatSpend(data.total.reportedCostUsd, data.total.estimatedCostUsd)}
            </div>
            <div className="mt-2 text-[11px] text-muted-foreground/65">
              {data.total.tokens.totalTokens.toLocaleString()} tokens
              {Option.getOrNull(data.since)
                ? ` • since ${DateTime.formatIso(Option.getOrNull(data.since)!).split("T")[0]}`
                : ""}
            </div>
          </div>
        ) : null}

        {data ? (
          <div className="space-y-0.5 rounded-lg border border-dashed border-border/60 bg-muted/20 px-4 py-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/65">
              Cost Legend
            </div>
            <div className="mt-2 space-y-1 text-[11px] text-muted-foreground/70">
              <div>
                <span className="font-medium">~$X.XX</span> = Reported + Estimated (model-based)
              </div>
              <div>
                <span className="font-medium">$X.XX</span> = Reported cost only
              </div>
            </div>
          </div>
        ) : null}

        <SpendTable entries={data?.byDriver ?? []} title="By Driver" />
        <SpendTable entries={data?.byModel ?? []} title="By Model" />

        {data && data.assumptions.length > 0 ? (
          <div className="mt-6">
            <h4 className="text-sm font-semibold text-foreground">Cost assumptions</h4>
            <p className="mt-1 text-xs text-muted-foreground/70">
              When token costs are not reported, these rates calculate the estimated cost.
            </p>
            <div className="mt-3 overflow-hidden rounded-lg border border-border/60">
              <table className="w-full table-fixed text-left text-xs">
                <colgroup>
                  <col className="w-[20%]" />
                  <col className="w-[15%]" />
                  <col className="w-[15%]" />
                  <col className="w-[15%]" />
                  <col className="w-[15%]" />
                  <col className="w-[20%]" />
                </colgroup>
                <thead className="border-b border-border/60 bg-muted/40 text-[10px] uppercase tracking-[0.08em] text-muted-foreground/65">
                  <tr>
                    <th className="px-3 py-2 font-semibold sm:pl-4">Model</th>
                    <th className="px-3 py-2 text-right font-semibold">Input</th>
                    <th className="px-3 py-2 text-right font-semibold">Output</th>
                    <th className="px-3 py-2 text-right font-semibold">Cache R</th>
                    <th className="px-3 py-2 text-right font-semibold">Cache W</th>
                    <th className="px-3 py-2 text-right font-semibold sm:pr-4">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {data.assumptions.map((assumption) => (
                    <tr key={assumption.key} className="hover:bg-muted/20">
                      <td className="truncate px-3 py-2 font-medium text-foreground sm:pl-4">
                        {assumption.key}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                        ${assumption.input.toFixed(4)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                        ${assumption.output.toFixed(4)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                        ${assumption.cacheRead.toFixed(4)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                        ${assumption.cacheWrite.toFixed(4)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-[10px] font-medium tabular-nums sm:pr-4">
                        {assumption.source === "published" ? "Published" : "Assumed"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}
      </div>
    </SettingsSection>
  );
}

function HarnessSection({
  cwd,
  projects,
  onSelectProject,
}: {
  cwd: string | null;
  projects: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly workspaceRoot: string;
  }>;
  onSelectProject: (workspaceRoot: string) => void;
}): ReactNode {
  const harnessQuery = useHarnessCatalog(cwd ? { cwd } : null);
  const providers = usePrimarySettings((settings) => settings.providers);
  const updateSettings = useUpdatePrimarySettings();

  const roleOverrides: Readonly<Record<string, HarnessRoleOverrides>> =
    providers.harness.roleOverrides;

  // The updater takes a patch, so the whole `providers` sub-object has to be
  // supplied to change one nested field without dropping the rest.
  const setWorkflowOverrides = (workflowName: string, next: HarnessRoleOverrides) => {
    const nextByWorkflow: Record<string, HarnessRoleOverrides> = {};
    for (const [name, entry] of Object.entries(roleOverrides)) {
      if (name !== workflowName) {
        nextByWorkflow[name] = entry;
      }
    }
    if (Object.keys(next).length > 0) {
      nextByWorkflow[workflowName] = next;
    }
    updateSettings({
      providers: {
        ...providers,
        harness: { ...providers.harness, roleOverrides: nextByWorkflow },
      } as typeof providers,
    });
  };

  // Workflows are declared per repository, so the list is only meaningful
  // against one project at a time.
  const projectPicker =
    projects.length <= 1 ? null : (
      <label className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
        <span>Project</span>
        <select
          className="rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-foreground"
          value={cwd ?? ""}
          onChange={(event) => onSelectProject(event.target.value)}
        >
          {projects.map((project) => (
            <option key={project.id} value={project.workspaceRoot}>
              {project.title}
            </option>
          ))}
        </select>
      </label>
    );

  if (!cwd) {
    return (
      <SettingsSection
        title="Agent Harness workflows"
        icon={<BoltIcon className="size-4 text-muted-foreground" />}
      >
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-4 py-5">
          <div className="text-sm font-medium text-foreground">Project workspace required</div>
          <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground/70">
            Workflows are read from the current project directory. Open a project to see available
            Agent Harness workflows.
          </p>
        </div>
      </SettingsSection>
    );
  }

  if (harnessQuery.isPending) {
    return (
      <SettingsSection
        title="Agent Harness workflows"
        icon={<BoltIcon className="size-4 text-muted-foreground" />}
      >
        <div className="rounded-xl border border-border/60 bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          Loading workflows...
        </div>
      </SettingsSection>
    );
  }

  if (harnessQuery.error) {
    return (
      <SettingsSection
        title="Agent Harness workflows"
        icon={<BoltIcon className="size-4 text-muted-foreground" />}
      >
        <div className="flex items-start gap-2 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{harnessQuery.error}</span>
        </div>
      </SettingsSection>
    );
  }

  const catalog = harnessQuery.data as HarnessCatalog | null;
  const unavailableReason = catalog ? Option.getOrNull(catalog.unavailable) : null;

  if (unavailableReason) {
    const messages: Record<string, string> = {
      noConfig:
        "This project does not declare an .agent-harness.toml, and no global one was found. Add one to the project, or keep workflows for every project in ~/.config/agent-harness/config.toml.",
      unreadableConfig: "The .agent-harness.toml configuration could not be parsed.",
      binaryMissing: "The agent-harness binary is not installed or not on your PATH.",
    };
    return (
      <SettingsSection
        title="Agent Harness workflows"
        icon={<BoltIcon className="size-4 text-muted-foreground" />}
      >
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-4 py-5">
          <div className="text-sm font-medium text-foreground">Workflows unavailable</div>
          <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground/70">
            {messages[unavailableReason] || "Workflows could not be loaded."}
          </p>
        </div>
      </SettingsSection>
    );
  }

  const workflows = catalog?.workflows ?? [];

  return (
    <SettingsSection
      title="Agent Harness workflows"
      icon={<BoltIcon className="size-4 text-muted-foreground" />}
    >
      {projectPicker}
      {workflows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/60 bg-muted/20 px-4 py-5">
          <div className="text-sm font-medium text-foreground">No workflows configured</div>
          <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-muted-foreground/70">
            Add workflow definitions to .agent-harness.toml to declare multi-step Agent Harness
            jobs.
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
          <div className="divide-y divide-border/50">
            {workflows.map((workflow) => (
              <div key={workflow.name} className="px-4 py-4 sm:px-5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-semibold text-foreground">{workflow.name}</h4>
                      {workflow.recommended ? (
                        <span className="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-emerald-700 dark:text-emerald-300">
                          Recommended
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span>Drivers: {workflow.drivers.join(", ")}</span>
                      <span>•</span>
                      <span>{workflow.stepCount} steps</span>
                    </div>
                    {workflow.description ? (
                      <p className="mt-1.5 max-w-xl text-xs leading-relaxed text-muted-foreground/80">
                        {workflow.description}
                      </p>
                    ) : null}
                    {workflow.steps.length > 0 ? (
                      <p className="mt-1 font-mono text-[10px] text-muted-foreground/60">
                        {workflow.steps.join(" → ")}
                      </p>
                    ) : null}
                  </div>
                </div>

                <HarnessRoleControls
                  workflow={workflow}
                  overrides={roleOverrides[workflow.name] ?? {}}
                  onChange={(next) => setWorkflowOverrides(workflow.name, next)}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

export function AgentUsageSettings({ cwd }: { cwd?: string | null } = {}): ReactNode {
  const projects = useProjects();
  const [selectedRoot, setSelectedRoot] = useState<string | null>(null);

  // Default to the first project rather than making the reader choose before
  // the section can say anything.
  const resolvedCwd = cwd ?? selectedRoot ?? projects[0]?.workspaceRoot ?? null;

  return (
    <>
      <ProvidersSection />
      <SpendSection />
      <HarnessSection
        cwd={resolvedCwd}
        projects={projects.map((project) => ({
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        }))}
        onSelectProject={setSelectedRoot}
      />
    </>
  );
}
