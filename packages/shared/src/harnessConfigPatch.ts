/**
 * Per-role provider/model/reasoning overrides for an Agent Harness config.
 *
 * The `agent-harness` CLI has no per-role flags: the only lever is
 * `--config <path>`, which replaces the whole file. So an override has to be
 * expressed as a complete, valid config.
 *
 * This patches the original text rather than parsing TOML and re-serializing
 * it. A real `.agent-harness.toml` carries comments explaining why a role runs
 * a given model, multi-line prompt strings, and key ordering that a subset
 * parser would quietly drop — and that file drives real multi-agent runs. So
 * we locate each `[agents.<role>]` table and rewrite only the keys asked for,
 * leaving every other byte where it was.
 */

export interface HarnessRoleOverride {
  /** Becomes `provider = "..."` — the harness's name for the CLI backend. */
  readonly driver?: string | undefined;
  readonly model?: string | undefined;
  readonly reasoning?: string | undefined;
}

/** Keyed by role name, e.g. `{ planner: { driver: "codex", model: "gpt-5.6-sol" } }` */
export type HarnessRoleOverrides = Readonly<Record<string, HarnessRoleOverride>>;

export interface HarnessConfigPatchResult {
  readonly toml: string;
  /** Roles whose table text actually changed. */
  readonly applied: ReadonlyArray<string>;
  /** Overrides naming a role with no `[agents.<role>]` table; the caller surfaces these. */
  readonly missingRoles: ReadonlyArray<string>;
}

/** The keys we are willing to rewrite, in the order inserted keys are emitted. */
const PATCHABLE = [
  { key: "provider", field: "driver" },
  { key: "model", field: "model" },
  { key: "reasoning", field: "reasoning" },
] as const;

function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Lines are split on "\n" only, so a CRLF file keeps its "\r" as the last
 * character of each line. Rewrites put it back rather than normalising it.
 */
function splitEol(line: string): { readonly body: string; readonly eol: string } {
  return line.endsWith("\r") ? { body: line.slice(0, -1), eol: "\r" } : { body: line, eol: "" };
}

function isTableHeader(line: string): boolean {
  return splitEol(line).body.trimStart().startsWith("[");
}

function agentTableName(line: string): string | null {
  const match = /^\s*\[agents\.([^\].\s]+)\]\s*$/.exec(splitEol(line).body);
  return match === null ? null : (match[1] ?? null);
}

/** Index of the `[agents.<role>]` header, or -1. Exact name match, so `review` never matches `reviewer`. */
function findTable(lines: ReadonlyArray<string>, role: string): number {
  return lines.findIndex((line) => agentTableName(line) === role);
}

/** First line after `start` that opens another table, or the end of the file. */
function tableEnd(lines: ReadonlyArray<string>, start: number): number {
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line !== undefined && isTableHeader(line)) {
      return index;
    }
  }
  return lines.length;
}

/** Rewrites `key = <value>` in place, preserving the line's indentation and spacing around `=`. */
function replaceValue(line: string, key: string, value: string): string | null {
  const { body, eol } = splitEol(line);
  const match = new RegExp(`^(\\s*${key}\\s*=\\s*)`).exec(body);
  return match === null ? null : `${match[1] ?? ""}${quote(value)}${eol}`;
}

export function patchHarnessConfig(
  originalToml: string,
  overrides: HarnessRoleOverrides,
): HarnessConfigPatchResult {
  const roles = Object.keys(overrides);
  if (roles.length === 0) {
    return { toml: originalToml, applied: [], missingRoles: [] };
  }

  let lines = originalToml.split("\n");
  const applied: string[] = [];
  const missingRoles: string[] = [];

  for (const role of roles) {
    const override = overrides[role];
    const wanted = PATCHABLE.flatMap(({ key, field }) => {
      const value = override?.[field];
      return value === undefined ? [] : [{ key, value }];
    });
    if (wanted.length === 0) {
      continue;
    }

    const header = findTable(lines, role);
    if (header === -1) {
      missingRoles.push(role);
      continue;
    }

    // Recomputed per role because an insertion shifts every later line.
    const end = tableEnd(lines, header);
    const next = [...lines];
    const inserts: string[] = [];
    let changed = false;

    for (const { key, value } of wanted) {
      let replaced = false;
      for (let index = header + 1; index < end; index += 1) {
        const line = next[index];
        if (line === undefined) {
          continue;
        }
        const rewritten = replaceValue(line, key, value);
        if (rewritten !== null) {
          replaced = true;
          if (rewritten !== line) {
            next[index] = rewritten;
            changed = true;
          }
          break;
        }
      }
      if (!replaced) {
        inserts.push(`${key} = ${quote(value)}${splitEol(lines[header] ?? "").eol}`);
        changed = true;
      }
    }

    if (inserts.length > 0) {
      next.splice(header + 1, 0, ...inserts);
    }
    if (changed) {
      applied.push(role);
      lines = next;
    }
  }

  return { toml: lines.join("\n"), applied, missingRoles };
}
