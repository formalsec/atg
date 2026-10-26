# atg

Agentic test generation. atg benchmarks coding agents (Claude Code, Codex CLI, Gemini CLI) that write E2E test suites (Playwright, Selenium, Cypress) for web apps.

This step runs one config end to end, for Claude Code and Playwright: it gives the agent a workspace, lets it write a suite, runs that suite on the fixed version of the app, and measures its browser-side line coverage. Bug finding comes in a later step.

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
| `atg eval <run_id> [--only evaluate\|coverage] [--runs-dir <dir>]` | Runs the evaluation stages of a finished run again from its saved `tests/`, without the agent, and writes `metrics.json` again. `--only` runs one stage. |
| `atg pilot <run_id> [--concurrency <n>] [--runs-dir <dir>]` | Prints the cost pilot report of one run. See [Cost pilot](#cost-pilot). |
| `atg signal <run_dir>` | Runs the workspace tests of a run in progress on the running fixed app and prints the coverage signal. The agent calls it through `./coverage`. See [Coverage signal](#coverage-signal). |
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
| `coverage_signal` | A subset of the implemented coverage tools (only `lines` today). Empty is allowed. See below. |
| `timeout_min` | Wall-clock minutes for prepare and generate. Fractions are allowed. Default `30`. |
| `rep` | Repetition index, a positive integer. Default `1`. |

Unknown keys are errors. A subset must not repeat an item.

### `coverage_signal` is the treatment, not the measurement

`coverage_signal` sets only the coverage that the agent sees as feedback while it works. Evaluation always measures every implemented coverage tool, for every run. An empty `coverage_signal` means "no feedback". It does not mean "no measurement". A tool that is not implemented cannot be a signal: `atg validate` rejects the config.

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
| `browser_dir`: folder inside `repo` that the app serves at the root of `url` | |

An app needs `url` or `start`. Other paths are relative to the app folder. Without `browser_dir`, browser-side line coverage is not measured for the app. Two example apps are fixtures for tests and demos: `demo-todo` provides all inputs, `demo-blog` has no code. `demo-todo` has a help page that the demo suites never open, so its script counts as untested. Their fixed and buggy versions are commits in a `repo.bundle`. To change one, clone the bundle, commit, move the tag and run `git bundle create repo.bundle --all`.

`ATG_APPS_DIR` points atg to another apps folder.

## Runs

`atg run` turns one config into one run folder. Five stages run in order. Each stage reads only the run folder, so `atg eval` can run an evaluation stage again.

| Stage | What it does |
| --- | --- |
| prepare | Resolves the refs to commits, creates a new workspace in the system temp folder, writes the selected inputs and a runnable test project into it, and writes the prompt. |
| generate | Starts the fixed version, calls the agent in the workspace, and copies the agent's `tests/` into the run folder. |
| evaluate | Starts a new fixed instance and runs the agent's tests on it with an atg-owned config: JSON reporter, 1 worker, 0 retries, base URL from the environment. |
| coverage | Starts a new fixed instance and runs the agent's tests on it again, with the collectors of every implemented coverage tool. See [Coverage](#coverage). |
| finalize | Writes `metrics.json`, atomically and last. |

The workspace gets only the selected inputs: `code/` is a plain export of the fixed commit (no git metadata), `task` and `examples` are copies from the app folder, and `url` is a running fixed instance. The buggy version is never exported during generation. The workspace must be outside your home folder and outside atg, because Claude Code loads `CLAUDE.md` from the working folder and every parent.

atg owns the app: it starts the app from an export of the version under test, waits until `url` answers, and always stops it. Generate starts the app before it calls the agent, also when `url` is not an input, so a broken start command fails before any money is spent. Without the `url` input and with an empty `coverage_signal`, atg stops the app again before the agent starts.

Coverage is collected only in the coverage stage, never in prepare or generate, so the agent stages take the same time with or without measurement. The pass and fail counts come from the evaluate stage, which runs without collectors.

### Run folder

| File | Content |
| --- | --- |
| `config.json` | The normalized config. |
| `prompt.md` | The prompt the agent got on stdin. |
| `agent-stdout.txt`, `agent-stderr.txt` | The agent's raw output. |
| `agent.json` | The agent result, normalized by its adapter. |
| `tests/` | The suite the agent left. |
| `results/fixed.json` | One entry per test on the fixed version (`passed`, `failed`, `flaky`, `skipped`), plus load errors. `fixed-report.json` is the raw report. |
| `results/coverage/` | The output of each implemented coverage tool in `<tool>/` (for `lines`, the Monocart report `lines/index.html`), `summary.json` with covered, total, pct, report path and what is uncovered per tool, and the logs of the coverage run. |
| `signal-calls.jsonl` | One line for each time the agent called the signal command. Only when `coverage_signal` is not empty. |
| `env.json` | atg commit and dirty flag, Node, OS, agent CLI version, requested and resolved models, isolation mode, the exact agent command, framework and browser versions, app SHAs, start and end times. |
| `stages.json` | Wall time and error of each stage. |
| `metrics.json` | Status, stop reason, tokens, cost and `cost_source`, turns, models, wall time per stage, `n_tests`, passed/failed/flaky/skipped on fixed, one `coverage` block per coverage tool (`covered`, `total`, `pct`, `report`, or `null` when not measured), and `signal_calls`. |

If `metrics.json` exists, `atg run` does nothing, and `atg eval` can run its evaluation again. `--force` redoes the run. A folder without `metrics.json` (a killed run) is deleted and the run starts again. `--dry-run` stops after prepare, keeps the workspace and prints the agent invocation. The workspace is deleted after generate unless you give `--keep-workspace`.

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

## Coverage

Coverage has two roles. The measurement: the coverage stage measures every implemented tool on the fixed version, for every run. The treatment: `coverage_signal` selects the tools whose numbers the agent can see while it works.

### Coverage port

A coverage adapter has three parts:

| Part | When | What it does |
| --- | --- | --- |
| `collector` (optional) | During the suite run, per test | A module that exports `collect(page, dir)`. The atg fixture calls it with the test's page before the test and calls the function it returns after the test. |
| `universe(run)` (optional) | Before the suite run | Writes into the tool folder everything the app version has (all lines, elements or endpoints). Denominators come from it, never from what one run touched. |
| `report(run)` | After the suite run | Returns `covered`, `total`, `pct`, the report path and what is uncovered, or `null` for "not measured" (never 0). |

`run` gives the app, an export of the fixed commit (`source`), the base URL and the tool folder. The Playwright adapter puts an atg-owned `@playwright/test` in the suite project. It extends `test` with a `page` fixture that hands every test's page to the enabled collectors, so a test the agent wrote needs no change to be measured. A test that opens its own page with `browser.newPage()` is not measured.

### Coverage tools

| Tool | Status | One unit | Universe | What the collector observes |
| --- | --- | --- | --- | --- |
| `lines`: browser-side line coverage | Implemented, with [Monocart](https://github.com/cenfun/monocart-coverage-reports) | One line of a JS or CSS file under the app's `browser_dir` | Every `.js`, `.mjs` and `.css` file under `browser_dir` in the fixed commit. A file that no test loads counts as 0%. | V8 JS and CSS coverage of the test's page, with `resetOnNavigation` off |
| `html`: HTML elements exercised | Not implemented, reports `null` | One interactive element (link, button, form field, element with a role) on one page, named by the page path and its role and accessible name | The interactive elements that a crawl of the fixed instance finds, from `url` through every same-origin link | The elements the test clicked, filled, checked or asserted on |
| `api`: API endpoints called | Not implemented, reports `null` | One endpoint: HTTP method and route template, for example `GET /todos/:id` | The app's route table or OpenAPI file at the fixed commit | The requests the test's page sent to the app's origin, matched to a route template |

The lines adapter saves the raw V8 data of each test in `raw/` in its tool folder. After the run, it adds that data to one Monocart report: entries are kept only when their URL is on the app's origin and maps to a file in `browser_dir`, and `all` adds the untested files of `browser_dir` with 0%. The numbers are Monocart's `summary.lines`. A URL path maps to the file with the same path under `browser_dir`, so an app that bundles its code needs source maps support before it can be measured. Scripts inside HTML files are not counted. Server code is not measured. To add it later, the app's server runs with `NODE_V8_COVERAGE` and the adapter adds that folder in `report`, with no change to the port.

To plug in a real `html` or `api` tool, give its registry entry an adapter and set `implemented: true`. `test/fixtures/fake-coverage.ts` does that from a test, and the result shows up in `metrics.json` with no change to the core.

### Coverage signal

When `coverage_signal` is not empty, prepare writes `./coverage` into the workspace, the prompt tells the agent about it, and the agent may run it. It runs the agent's current tests on the running fixed instance with the collectors of the selected tools only, and prints, for each one, the pct and what is still uncovered. Its output goes to a temp folder that it deletes, so it never changes the evaluation outputs. Each call adds one line to `signal-calls.jsonl`, and `metrics.json` keeps the count in `signal_calls`. When `coverage_signal` is empty, the workspace has no `./coverage` and the prompt does not mention it. The evaluation is the same in both cases.

## Cost pilot

`atg pilot <run_id>` prints a Markdown report of one run folder: wall time per stage, tokens by type, cost and `cost_source`, turns, `n_tests` and pass/fail on fixed, and coverage per tool. It then estimates the full grid of 11,520 runs: total cost, total agent-hours, and calendar time with `--concurrency` runs at a time per agent (default 1). It writes each assumption next to its number: every run costs and takes what this run did, and the 3 agents of the grid run side by side.

The pilot config is `configs/pilot.json`: Claude Code, all four inputs, every implemented tool as signal, Playwright, rep 1, and `max_budget_usd` set.

```sh
atg run configs/pilot.json
atg pilot <run_id> --concurrency 4
```

## Registries

`src/registries.ts` holds the agents, frameworks and coverage tools as named descriptors (`name`, `label`, `implemented`), and the three ports. An agent adapter turns the workspace, prompt, agent config and time limit into a process invocation, and turns that process's output into a normalized result. A framework adapter scaffolds a runnable test project and runs a test folder against a base URL with the given coverage collectors, and gives a normalized per-test result list. A coverage adapter is described in [Coverage port](#coverage-port). The adapters are in `src/adapters/`. The rest of the code does not name a specific agent, framework or coverage tool. The wizard shows options that are not implemented, but you cannot select them. `atg validate` accepts every registry name, except a coverage tool that is not implemented in `coverage_signal`.

## Tests

```sh
npm test
npm run typecheck
```

The pipeline tests spend no money: `test/fixtures/fake-agent.ts` registers a fake agent that writes a known suite, calls the signal command, waits, or hangs. `test/fixtures/atg-fake-coverage.ts` also replaces the `html` stub with a fake adapter.
