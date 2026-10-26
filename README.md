# atg

Agentic test generation. atg benchmarks coding agents (Claude Code, Codex CLI, Gemini CLI) that write E2E test suites (Playwright, Selenium, Cypress) for web apps.

This step runs one config end to end, for Claude Code and Playwright: it gives the agent a workspace, lets it write a suite, and runs that suite on the fixed version of the app. Coverage and bug finding come in later steps.

## Setup

You need Node 24 or later. Node runs the TypeScript sources directly, so there is no build step.

```sh
npm install
npx playwright install --only-shell chromium
npm link        # optional: puts `atg` on your PATH
node src/cli.ts doctor
```

`atg doctor` tells you what is missing. It never calls a model.

## Commands

| Command | What it does |
| --- | --- |
| `atg validate <config...> [--json]` | Checks each config file. Prints the normalized config and its `run_id`, or readable errors. Exits with 1 if a file is not valid. |
| `atg schema [--out <file>]` | Prints the config JSON Schema. |
| `atg apps [--json]` | Lists the apps and the inputs each app provides. |
| `atg new [--out <file>] [--from <config>]` | Creates a config with an interactive wizard. `--from` prefills the answers from a config. Without `--out`, the file is `<run_id>.json`. Ctrl+C writes nothing. |
| `atg run <config> [--dry-run] [--force] [--runs-dir <dir>] [--keep-workspace]` | Runs one config into the run folder `<runs-dir>/<run_id>/` (default `runs/`). See [Runs](#runs). |
| `atg doctor` | Checks the agent CLI and its isolation mode (API key or subscription login), Playwright and its Chromium build, and the app start commands. Exits with 1 if a check fails. |

## Config v1

```json
{
  "schema": 1,
  "app": "demo-todo",
  "inputs": ["code", "url"],
  "agent": { "name": "claude", "model": "claude-opus-5-5", "max_turns": 50 },
  "framework": "playwright",
  "coverage_signal": ["lines"],
  "timeout_min": 30,
  "rep": 1
}
```

| Field | Rule |
| --- | --- |
| `schema` | Always `1`. |
| `app` | An app id from `atg apps`. |
| `inputs` | What the agent gets: a subset of `url`, `task`, `examples`, `code`. Empty is allowed. The app must provide each input. |
| `agent` | `name` from the agent registry, `model` (text), optional `max_turns` and `max_budget_usd`. |
| `framework` | A name from the framework registry. |
| `coverage_signal` | A subset of `lines`, `html`, `api`. Empty is allowed. See below. |
| `timeout_min` | Wall-clock minutes for prepare and generate. Fractions are allowed. Default `30`. |
| `rep` | Repetition index, a positive integer. Default `1`. |

Unknown keys are errors. A subset must not repeat an item.

### `coverage_signal` is the treatment, not the measurement

`coverage_signal` sets only the coverage that the agent sees as feedback while it works. Evaluation always measures all three coverage tools (`lines`, `html`, `api`), for every run. An empty `coverage_signal` means "no feedback". It does not mean "no measurement".

### Normalization and `run_id`

Before any other step, atg normalizes a config: it applies the defaults and sorts `inputs` and `coverage_signal`. Two equivalent configs give the same bytes.

`run_id` is `<app>__<agent>__<framework>__<hash8>`. The hash is SHA-256 over the normalized config (`rep` included), the commit SHAs that `fixed_ref` and `buggy_ref` resolve to, and the prompt template `src/prompt.md`. A tag that moves or an edit to the template gives a new `run_id`. There is no timestamp. The same content gives the same `run_id`, so a later step can resume a run. Different content gives a different `run_id`.

## Apps

Each app has a folder `apps/<id>/` with an `app.json`. The `id` must be the folder name.

| Field | Gives the input |
| --- | --- |
| `repo` (required): git URL, path or bundle of the app's source | |
| `fixed_ref`, `buggy_ref` (required): refs in `repo` | |
| `url` | `url` |
| `start` (command that starts the app, run from an export of a version) | |
| `stories_file` | `task` |
| `examples_dir` | `examples` |
| `code_dir`: folder inside `repo`, `.` for the whole commit | `code` |

An app needs `url` or `start`. Other paths are relative to the app folder. Two example apps are fixtures for tests and demos: `demo-todo` provides all inputs, `demo-blog` has no code. Their fixed and buggy versions are commits in a `repo.bundle`. To change one, clone the bundle, commit, move the tag and run `git bundle create repo.bundle --all`.

`ATG_APPS_DIR` points atg to another apps folder.

## Runs

`atg run` turns one config into one run folder. Four stages run in order. Each stage reads only the run folder, so a later step can run one stage again.

| Stage | What it does |
| --- | --- |
| prepare | Resolves the refs to commits, creates a new workspace in the system temp folder, writes the selected inputs and a runnable test project into it, and writes the prompt. |
| generate | Starts the fixed version, calls the agent in the workspace, and copies the agent's `tests/` into the run folder. |
| evaluate | Starts a new fixed instance and runs the agent's tests on it with an atg-owned config: JSON reporter, 1 worker, 0 retries, base URL from the environment. |
| finalize | Writes `metrics.json`, atomically and last. |

The workspace gets only the selected inputs: `code/` is a plain export of the fixed commit (no git metadata), `task` and `examples` are copies from the app folder, and `url` is a running fixed instance. The buggy version is never exported during generation. The workspace must be outside your home folder and outside atg, because Claude Code loads `CLAUDE.md` from the working folder and every parent.

atg owns the app: it starts the app from an export of the version under test, waits until `url` answers, and always stops it. Generate starts the app before it calls the agent, also when `url` is not an input, so a broken start command fails before any money is spent. Without the `url` input, atg stops the app again before the agent starts.

### Run folder

| File | Content |
| --- | --- |
| `config.json` | The normalized config. |
| `prompt.md` | The prompt the agent got on stdin. |
| `agent-stdout.txt`, `agent-stderr.txt` | The agent's raw output. |
| `agent.json` | The agent result, normalized by its adapter. |
| `tests/` | The suite the agent left. |
| `results/fixed.json` | One entry per test on the fixed version (`passed`, `failed`, `flaky`, `skipped`), plus load errors. `fixed-report.json` is the raw report. |
| `env.json` | atg commit and dirty flag, Node, OS, agent CLI version, requested and resolved models, isolation mode, the exact agent command, framework and browser versions, app SHAs, start and end times. |
| `stages.json` | Wall time and error of each stage. |
| `metrics.json` | Status, stop reason, tokens, cost and `cost_source`, turns, models, wall time per stage, `n_tests`, and passed/failed/flaky/skipped on fixed. |

If `metrics.json` exists, `atg run` does nothing. `--force` redoes the run. A folder without `metrics.json` (a killed run) is deleted and the run starts again. `--dry-run` stops after prepare, keeps the workspace and prints the agent invocation. The workspace is deleted after generate unless you give `--keep-workspace`.

Each run has one status:

| Status | When |
| --- | --- |
| `ok` | The run finished. This includes an agent that stopped at `max_turns` or `max_budget_usd`; `stop_reason` keeps why. |
| `agent_error` | No parseable result, `error_during_execution`, or an auth or CLI failure. |
| `infra_error` | atg, the app start, the export or the browser failed. Exits with 1. |
| `timeout` | `timeout_min` passed during prepare or generate. atg kills the agent's whole process tree. |

atg evaluates the tests the agent left for every status except `infra_error`. The evaluation has its own limit of `timeout_min`. Ctrl+C or SIGTERM stops every process that atg started and deletes its temp folders, the workspace too unless you give `--keep-workspace`. After SIGKILL, the app can keep its port, and the next run then fails with `infra_error` until you stop it.

### Claude Code

The adapter runs `claude -p --output-format json` with `--model`, `--max-turns` and `--max-budget-usd` when set, `--permission-mode dontAsk`, `--allowedTools` limited to `Read`, `Edit` and `Write` inside the workspace and `npx playwright test`, `--no-session-persistence`, and `--strict-mcp-config` with no servers. The agent gets a clean environment: only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG` and `TERM`.

| Isolation mode | When | Flags |
| --- | --- | --- |
| `bare` | `ANTHROPIC_API_KEY` is set | `--bare`. Bare mode never uses the subscription login. |
| `settings` | No API key, subscription login | `--setting-sources ""` and `--settings` with `claudeMdExcludes` for `~/.claude/**` and `autoMemoryEnabled: false`, because user memory loads even without the `user` setting source ([#86837](https://github.com/anthropics/claude-code/issues/86837)). |

Tokens and cost are sums over `modelUsage`, because `usage` covers only the main loop. The cost is an API-price estimate (`cost_source` is `estimate:<costBasis>`), not a bill, also on a subscription.

Isolation probe (2026-10-26, Claude Code 2.1.310, `settings` mode): asked to list the `CLAUDE.md`, rules and memory files in its context, the agent answered none. These still load, because they are part of Claude Code: its system prompt, its commit attribution reminder, and 14 bundled skills (for example `claude-api`, `init`, `security-review`). Without the isolation flags, the same probe lists `~/.claude/CLAUDE.md`, every plugin skill, plugin hooks and a plugin MCP server, which `--strict-mcp-config` alone does not stop. `bare` mode was not probed (no API key on that machine). The isolation keeps context out, it is not a sandbox: a test the agent runs is Node code and can read any file the user can read.

## Registries

`src/registries.ts` holds the agents, frameworks and coverage tools as named descriptors (`name`, `label`, `implemented`), and the two ports. An agent adapter turns the workspace, prompt, agent config and time limit into a process invocation, and turns that process's output into a normalized result. A framework adapter scaffolds a runnable test project and runs a test folder against a base URL, and gives a normalized per-test result list. The adapters are in `src/adapters/`. The rest of the code does not name a specific agent, framework or coverage tool. The wizard shows options that are not implemented, but you cannot select them. `atg validate` accepts every registry name.

## Tests

```sh
npm test
npm run typecheck
```

The pipeline tests spend no money: `test/fixtures/fake-agent.ts` registers a fake agent that writes a known suite, waits, or hangs.
