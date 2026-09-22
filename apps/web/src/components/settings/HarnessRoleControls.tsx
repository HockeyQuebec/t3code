import * as Option from "effect/Option";
import type { ReactNode } from "react";
import type { HarnessWorkflowSummary } from "@t3tools/contracts";

import { Button } from "../ui/button";

/**
 * Per-role harness overrides. A workflow declares which provider and model runs
 * each of its roles; an override says "run this role somewhere else" without
 * changing the workflow's steps.
 */
export type HarnessRoleOverride = {
  readonly driver?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoning?: string | undefined;
};

/** Overrides for one workflow, keyed by role name. */
export type HarnessRoleOverrides = Readonly<Record<string, HarnessRoleOverride>>;

export const HARNESS_OVERRIDE_FIELDS = ["driver", "model", "reasoning"] as const;
export type HarnessOverrideField = (typeof HARNESS_OVERRIDE_FIELDS)[number];

/** Driver kinds this app can route a role to. */
export const HARNESS_DRIVER_OPTIONS: ReadonlyArray<{
  readonly value: string;
  readonly label: string;
}> = [
  { value: "claudeAgent", label: "Claude" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
  { value: "grok", label: "Grok" },
  { value: "opencode", label: "OpenCode" },
];

export const HARNESS_REASONING_OPTIONS: ReadonlyArray<string> = ["low", "medium", "high"];

/**
 * Set one field of one role's override, returning a new record.
 *
 * An empty value clears the field, and a role left with no fields is dropped
 * entirely — the stored object only ever holds choices the user actually made.
 */
export function applyRoleOverride(
  overrides: HarnessRoleOverrides,
  role: string,
  field: HarnessOverrideField,
  value: string,
): HarnessRoleOverrides {
  const current = overrides[role] ?? {};
  const nextRole: { driver?: string; model?: string; reasoning?: string } = {};
  for (const key of HARNESS_OVERRIDE_FIELDS) {
    const nextValue = (key === field ? value : (current[key] ?? "")).trim();
    if (nextValue.length > 0) {
      nextRole[key] = nextValue;
    }
  }

  const next: Record<string, HarnessRoleOverride> = {};
  for (const [name, entry] of Object.entries(overrides)) {
    if (name !== role) {
      next[name] = entry;
    }
  }
  if (Object.keys(nextRole).length > 0) {
    next[role] = nextRole;
  }
  return next;
}

/** True when a workflow has at least one role override worth resetting. */
export function hasRoleOverrides(overrides: HarnessRoleOverrides): boolean {
  return Object.keys(overrides).length > 0;
}

function modeLabel(mode: string): string {
  return mode === "read" ? "Inspector" : mode === "write" ? "Can modify" : "Unknown mode";
}

const controlClassName =
  "rounded-md border border-border/60 bg-background px-2 py-1 text-xs text-foreground";

export function HarnessRoleControls({
  workflow,
  overrides,
  onChange,
}: {
  workflow: HarnessWorkflowSummary;
  overrides: HarnessRoleOverrides;
  onChange: (next: HarnessRoleOverrides) => void;
}): ReactNode {
  if (workflow.roles.length === 0) {
    return null;
  }

  const setField = (role: string, field: HarnessOverrideField, value: string) => {
    onChange(applyRoleOverride(overrides, role, field, value));
  };

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
          Roles
        </div>
        {hasRoleOverrides(overrides) ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="text-[10px] text-muted-foreground"
            onClick={() => onChange({})}
          >
            Reset to defaults
          </Button>
        ) : null}
      </div>

      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground/60">
        An override does not change the workflow: it still runs its declared steps, but this role
        runs on the provider and model you choose here.
      </p>

      <div className="mt-2 space-y-2">
        {workflow.roles.map((role) => {
          const declaredModel = Option.getOrNull(role.model);
          const override = overrides[role.name] ?? {};
          return (
            <div
              key={role.name}
              className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2"
            >
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-medium text-foreground">{role.name}</span>
                <span className="text-[10px] text-muted-foreground/60">{modeLabel(role.mode)}</span>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span>Provider</span>
                  <select
                    className={controlClassName}
                    aria-label={`Provider for ${role.name}`}
                    value={override.driver ?? ""}
                    onChange={(event) => setField(role.name, "driver", event.target.value)}
                  >
                    <option value="">Default ({role.driver})</option>
                    {HARNESS_DRIVER_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span>Model</span>
                  <input
                    type="text"
                    className={controlClassName}
                    aria-label={`Model for ${role.name}`}
                    placeholder={declaredModel ?? "provider default"}
                    value={override.model ?? ""}
                    onChange={(event) => setField(role.name, "model", event.target.value)}
                  />
                </label>

                <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span>Reasoning</span>
                  <select
                    className={controlClassName}
                    aria-label={`Reasoning for ${role.name}`}
                    value={override.reasoning ?? ""}
                    onChange={(event) => setField(role.name, "reasoning", event.target.value)}
                  >
                    <option value="">Default</option>
                    {HARNESS_REASONING_OPTIONS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
