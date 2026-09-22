import type { HarnessAgentRole, HarnessWorkflow } from "./harnessWorkflow.ts";

/**
 * Saying what a workflow actually does, in a sentence.
 *
 * No harness config carries a description field, so the alternative to deriving
 * one is hard-coding copy for the workflow names we happen to have seen — which
 * would be wrong for anyone else's repository and would silently rot when a
 * workflow changes shape. This reads the declared steps instead, so the
 * sentence is always true of the thing it describes.
 */

/**
 * Node names are conventional rather than specified, so these are recognised as
 * a courtesy and anything unfamiliar falls back to the node's own name.
 */
const STEP_PHRASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^plan/i, "plans the change"],
  [/^(implement|code|write|build)/i, "implements the change"],
  [/^(repair|fix)/i, "repairs failures"],
  [/^review/i, "reviews the work"],
  [/^(test|spec)/i, "runs tests"],
  [/^typecheck/i, "typechecks"],
  [/^lint/i, "lints"],
  [/^(changed|diff)/i, "checks what changed"],
  [/^(judge|evaluate|score)/i, "evaluates the outcome"],
];

function phraseFor(step: string): string {
  for (const [pattern, phrase] of STEP_PHRASES) {
    if (pattern.test(step)) {
      return phrase;
    }
  }
  return step.replace(/[_-]+/g, " ").trim();
}

/** Joins with commas and a trailing "and", so the sentence reads naturally. */
function joinPhrases(phrases: ReadonlyArray<string>): string {
  if (phrases.length <= 1) {
    return phrases[0] ?? "";
  }
  if (phrases.length === 2) {
    return `${phrases[0]} and ${phrases[1]}`;
  }
  return `${phrases.slice(0, -1).join(", ")}, and ${phrases[phrases.length - 1]}`;
}

/** Node names in declared order. */
export function harnessWorkflowSteps(workflow: HarnessWorkflow): ReadonlyArray<string> {
  return (workflow.nodes ?? []).map((node) => node.name).filter((name) => name.length > 0);
}

/**
 * Whether any role this workflow uses is allowed to change the worktree. A
 * review-only workflow reads very differently and the reader needs to know
 * before starting one.
 */
export function harnessWorkflowWrites(
  workflow: HarnessWorkflow,
  agents: ReadonlyArray<HarnessAgentRole>,
): boolean {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  for (const node of workflow.nodes ?? []) {
    const names = [...(node.agent === undefined ? [] : [node.agent]), ...(node.agents ?? [])];
    for (const name of names) {
      if (byName.get(name)?.mode === "write") {
        return true;
      }
    }
  }
  return false;
}

export function describeHarnessWorkflow(
  workflow: HarnessWorkflow,
  agents: ReadonlyArray<HarnessAgentRole>,
): string {
  const steps = harnessWorkflowSteps(workflow);
  if (steps.length === 0) {
    return "Declares no steps.";
  }

  // Repeated phrases add nothing: three separate check steps still just
  // "checks", and a repair loop revisiting implement should not say so twice.
  const phrases: string[] = [];
  for (const step of steps) {
    const phrase = phraseFor(step);
    if (!phrases.includes(phrase)) {
      phrases.push(phrase);
    }
  }

  const scope = harnessWorkflowWrites(workflow, agents)
    ? "Makes changes in an isolated worktree."
    : "Reads only — makes no changes.";
  // Naming the providers beats counting them: which subscriptions a run spends
  // is the thing a reader is deciding about.
  const runsOn =
    workflow.providers.length > 0 ? ` Runs on ${joinPhrases([...workflow.providers])}.` : "";

  return `${scope}${runsOn} It ${joinPhrases(phrases)}.`;
}
