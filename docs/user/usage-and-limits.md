# Usage, Limits, and Harness Workflows

T3 Code shows how much of each provider subscription you have left, what your work is costing, and
which multi-agent workflows a project declares.

## Provider Limits

The bottom of the sidebar, just above Settings, lists every subscription T3 Code can see, with both
of its windows and how long until each refills:

```
chuck                  active
5h 30% · 4h 27m   7d 43% · 2d 8h
ChatGPT                Plus plan
5h 89% · 1h 10m   7d 19% · 5d
Cursor                 Free plan · no usage meter
```

The percentage is how much of the window you have **used**. A window turns amber below 25% headroom
and red below 5%. Click **Limits** to open Settings → Usage.

Where the numbers come from:

- **Claude.** If you use claude-swap (`cswap`) to rotate between Claude
  accounts, every managed account gets its own row, with the active one marked. Without it, Claude
  shows up after its first turn, from the limits it reports while running.
- **ChatGPT (Codex).** Read from Codex's most recent session log, then kept current by the live
  numbers Codex reports during a turn.
- **Cursor.** The Cursor CLI only exposes your plan tier, not a usage meter, so that is all it shows.

## Token Usage in a Chat

The ring next to the send button shows how full the chat's context window is, with the token count
beside it (`84k/1M`). Hover it for the total tokens the chat has processed.

### Stale readings

A reading describes the window that was in force when the provider sent it. Once that window's reset
time passes, the number is history rather than headroom, and the chip says so instead of continuing
to claim you are nearly out.

## Spend

**Settings → Usage** adds up the tokens and cost of the work T3 Code has run, broken down by provider
and by model, over Today / Week / Month / All.

Two things about the cost column are worth knowing:

- **Claude reports its own cost.** Those dollars are what you were charged.
- **Codex and Cursor report only token counts.** T3 Code prices those from a rate table so they do
  not read as $0.00. A figure that includes an estimate is written with a `~`, and the panel lists
  every rate it used and whether that rate is published by the vendor or assumed by T3 Code.

The two are never added together silently — a total can always be split back into what was billed
and what was modelled.

### The ledger starts when the server does

Spend is tracked in memory, so restarting the server starts the count over. When a window reaches
back further than the server has been running, the panel says the total is partial rather than
implying it is the whole story.

## Agent Harness Workflows

Some projects declare multi-step workflows — plan, implement, test, review — that run across several
providers instead of putting one prompt to one agent. These live in an `.agent-harness.toml` at the
root of the project.

### Running one

Agent Harness appears in the model picker as a provider, alongside Claude and Codex. Pick it, then
pick the workflow you want where you would normally pick a model, and send your prompt as usual.

The run happens in an isolated git worktree, not your checkout. As it goes, each workflow node —
`plan`, `implement`, `review` — appears in the thread as its own step, showing which provider and
model ran it, how long it took, and what it cost. When the run finishes you get the worktree path so
you can inspect the changes before merging them.

A harness run is a batch, not a conversation: you cannot steer it mid-flight, and it has no approval
prompts. Interrupting the turn stops the run.

### If it says the harness is unavailable

T3 Code looks for `agent-harness` on your `PATH`. If yours is a source checkout rather than an
installed package, point at it explicitly:

```sh
export AGENT_HARNESS_BIN="$HOME/Repos/agent-harness/harness"
```

The launcher in a checkout needs its own source root importable; T3 Code detects that and sets it
for you, so the variable above is all you need.

### Controlling which agents run

A workflow declares its roles — `planner`, `implementer`, `reviewer` — and which provider and model
each one uses. You can override that per role: pick a different provider, a different model, or a
different reasoning effort.

Two places do the same thing:

- **In the composer.** Select a harness workflow and an **Agents** button appears beside the model
  picker, showing how many roles the workflow has and how many you have changed. It opens on the
  workflow's description, its step sequence, and a row per role.
- **Settings → Usage**, for every workflow the project declares at once.

Overrides do not change the workflow's shape. It still runs the same steps in the same order; only
the agent behind a given role changes. Leave a field on "Default" and the repository's own choice
stands.

Your repository's `.agent-harness.toml` is never modified. When a run starts with overrides in
effect, T3 Code copies that config, rewrites just the keys you changed, and points the run at the
copy — which is kept under the harness home so you can read exactly what ran.

"Reset to defaults" clears every override for that workflow.

### Which workflows are offered

The workflow list is provider configuration, not something read from each repo, because model lists
in T3 Code are fixed per provider rather than per project. Edit it in provider settings. When you
run one, T3 Code checks it really exists in that project's `.agent-harness.toml` and tells you
plainly if it does not.

**Settings → Usage** lists the workflows the current project declares, the providers each draws on,
and the role each provider plays.

### What each workflow does

No harness config carries a description field, so T3 Code writes one from the workflow's actual
steps — whether it changes files or only reads, which providers it spends, and what it does in
order. Because it is derived rather than written down, it cannot drift out of date when a workflow
changes, and it works for workflows this app has never seen. The raw step sequence
(`plan → implement → tests → review`) is shown underneath.

## Scheduling Work for Later

The clock button beside the send arrow queues a prompt instead of running it now — in an hour,
tonight, tomorrow morning, or a time you pick.

Scheduled work is stored on the server, so it runs whether or not the app is open. Closing the
browser, locking the laptop, or restarting the server does not lose it. The server checks for due
work every fifteen seconds.

**Settings → Usage** lists everything queued, with a countdown and a Cancel button. A scheduled turn
that could not start stays in that list with the reason it failed, rather than disappearing.

This is the piece that makes an overnight queue work: line up several prompts, spread them across
the hours, and read the results in the morning.

## Resuming Work a Usage Limit Cut Short

Running out of allowance mid-job does not end the job. When a turn fails because a provider's usage
limit was reached, the server works out when that window reopens and queues the work to continue
just after — so a run that hits a five-hour wall at 1am carries on by itself at 6am instead of being
found dead in the morning.

The reset time comes from the provider's own message when it names one ("resets at 4:00am"),
otherwise from the limit readings on this page, and otherwise from a thirty-minute retry. Resumed
work appears in the **Scheduled work** list marked _Limit resume_, with the same countdown and
Cancel button as anything you queued yourself, and the thread itself says that it is waiting.

How the work resumes depends on what was running:

- **A normal agent thread** keeps its session, so it is simply told to carry on from where it
  stopped rather than start over.
- **An Agent Harness run** has no session to carry on from — the run is one process, and it died
  with the limit. So the workflow is invoked again with the same task and the same workflow, and
  told which worktree the interrupted run left its partial work in, so the new run builds on it
  instead of repeating it.

Two guards stop this from becoming a loop: a thread never has more than one resume queued at a
time, and it gets at most six automatic resumes in a rolling day. A job that keeps hitting the wall
stops and waits for you rather than spending the allowance on its own.

Set `T3CODE_AUTO_RESUME_ON_USAGE_LIMIT=0` in the server's environment to turn this off entirely;
failed turns then simply stay failed.
