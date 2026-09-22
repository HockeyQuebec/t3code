import { BotIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { HarnessCatalog, HarnessWorkflowSummary } from "@t3tools/contracts";

import { useHarnessCatalog } from "../../lib/agentLimitsState";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { HarnessRoleControls, type HarnessRoleOverrides } from "../settings/HarnessRoleControls";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

/** `evaluated_change` reads as "Evaluated change" once it is on screen. */
function humaniseWorkflowName(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.length === 0 ? name : words.charAt(0).toUpperCase() + words.slice(1);
}

function overriddenRoleCount(workflow: HarnessWorkflowSummary, overrides: HarnessRoleOverrides) {
  return workflow.roles.filter((role) => overrides[role.name] !== undefined).length;
}

/**
 * The popover body. Exported so it can be rendered — and asserted on — without
 * driving the popover open, which a static render cannot do.
 */
export function HarnessAgentsPanel({
  workflow,
  overrides,
  onChange,
}: {
  workflow: HarnessWorkflowSummary;
  overrides: HarnessRoleOverrides;
  onChange: (next: HarnessRoleOverrides) => void;
}): ReactNode {
  // `description` and `steps` are filled in by the server; until it does, they
  // arrive empty and the line is dropped rather than rendered blank.
  const description = workflow.description.trim();
  const steps = workflow.steps.filter((step) => step.trim().length > 0);

  return (
    <div className="flex w-80 max-w-full flex-col text-left">
      <div className="text-sm font-semibold text-foreground">
        {humaniseWorkflowName(workflow.name)}
      </div>
      {description.length > 0 ? (
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">{description}</p>
      ) : null}
      {steps.length > 0 ? (
        <div className="mt-2 text-[11px] text-muted-foreground/70">{steps.join(" → ")}</div>
      ) : null}

      {/* HarnessRoleControls renders the per-role rows and, once
          `hasRoleOverrides` holds, its own "Reset to defaults" button. */}
      <HarnessRoleControls workflow={workflow} overrides={overrides} onChange={onChange} />
    </div>
  );
}

/**
 * Composer-level view of which provider runs each role of the selected harness
 * workflow, so a route can be changed where it is chosen rather than only in
 * Settings.
 */
export function HarnessAgentsControl({
  workflow,
  cwd,
}: {
  /** The selected harness workflow name, or null when the selected model is not a harness workflow. */
  workflow: string | null;
  /** Project directory used to look up the workflow's declared roles. */
  cwd: string | null;
}): ReactNode {
  const harnessQuery = useHarnessCatalog(workflow !== null && cwd ? { cwd } : null);
  const providers = usePrimarySettings((settings) => settings.providers);
  const updateSettings = useUpdatePrimarySettings();

  const roleOverrides: Readonly<Record<string, HarnessRoleOverrides>> =
    providers.harness.roleOverrides;

  const catalog = harnessQuery.data as HarnessCatalog | null;
  const summary =
    workflow === null ? undefined : catalog?.workflows.find((entry) => entry.name === workflow);

  if (workflow === null || !cwd || summary === undefined) {
    return null;
  }

  const overrides = roleOverrides[workflow] ?? {};
  const changedCount = overriddenRoleCount(summary, overrides);
  const label =
    changedCount > 0
      ? `Agents · ${summary.roles.length} · ${changedCount} changed`
      : `Agents · ${summary.roles.length}`;

  // The updater takes a patch, so the whole `providers` sub-object has to be
  // supplied to change one nested field without dropping the rest.
  const setWorkflowOverrides = (next: HarnessRoleOverrides) => {
    const nextByWorkflow: Record<string, HarnessRoleOverrides> = {};
    for (const [name, entry] of Object.entries(roleOverrides)) {
      if (name !== workflow) {
        nextByWorkflow[name] = entry;
      }
    }
    if (Object.keys(next).length > 0) {
      nextByWorkflow[workflow] = next;
    }
    updateSettings({
      providers: {
        ...providers,
        harness: { ...providers.harness, roleOverrides: nextByWorkflow },
      } as typeof providers,
    });
  };

  return (
    <Popover>
      <PopoverTrigger
        render={
          <ComposerControl
            type="button"
            className="shrink-0 whitespace-nowrap"
            aria-label={`Agents for ${humaniseWorkflowName(summary.name)}`}
          />
        }
      >
        <ComposerControlIcon icon={BotIcon} opticalSize="large" />
        <span>{label}</span>
      </PopoverTrigger>
      <PopoverPopup side="top" align="start" className="max-w-none">
        <HarnessAgentsPanel
          workflow={summary}
          overrides={overrides}
          onChange={setWorkflowOverrides}
        />
      </PopoverPopup>
    </Popover>
  );
}
