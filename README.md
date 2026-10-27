# atg

atg measures how well a coding agent writes end-to-end tests for a web app. Today it works with Claude Code and Playwright.

## How it works

1. You write a config. It names the app, the agent, the model and what the agent gets about the app.
2. atg gives the agent a new, empty folder with those inputs. The agent writes Playwright tests.
3. atg runs the tests 3 times on the correct version of the app (`fixed`).
4. atg runs the tests 3 times on a version of the app that has a known bug (`buggy`).
5. A test that passes every time on `fixed` and fails every time on `buggy` finds the bug.
6. atg also measures which lines of the app's browser code the tests run (line coverage).
7. atg writes all results to `runs/<run_id>/`. The main file is `metrics.json`.

## Setup

You need Node 24 or later. There is no build step.

```sh
npm install
npx playwright install --only-shell chromium
node src/cli.ts doctor
```

`atg doctor` shows what is missing. It never calls a model. To put `atg` on your PATH, run `npm link`.

## Quick start

```sh
atg apps
atg new
atg run my-config.json --dry-run
atg run my-config.json
```

`atg apps` lists the apps. `atg new` makes a config with a wizard. `--dry-run` shows the agent command and spends no money. The last command does the full run.

## Commands

| Command | What it does |
| --- | --- |
| `atg new` | Makes a config with a wizard. |
| `atg validate <config...>` | Checks configs and prints the `run_id` of each one. |
| `atg run <config>` | Does one run: the agent writes the tests, then atg evaluates them. |
| `atg eval <run_id>` | Evaluates the saved tests of a run again. It does not call the agent. |
| `atg pilot <run_id>` | Prints the cost of one run and an estimate for the full grid of 11,520 runs. |
| `atg apps` | Lists the apps and the inputs that each app gives. |
| `atg schema` | Prints the config JSON Schema. |
| `atg doctor` | Makes sure that the agent, Playwright and the apps are ready. |

`atg <command> --help` shows the options. On `run` and `eval`, `--reruns <n>` sets how many times the tests run on each version. The default is 3.

## Config

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

| Field | Meaning |
| --- | --- |
| `app` | An app from `atg apps`. |
| `inputs` | What the agent gets: `url` (the running app), `task` (user stories), `examples` (example tests) and `code` (source code). It can be empty. |
| `agent` | The agent `name` and `model`. `max_turns` and `max_budget_usd` are optional limits. |
| `framework` | Only `playwright` works today. |
| `coverage_signal` | `["lines"]` lets the agent see its line coverage while it works. `[]` hides it. atg always measures coverage at the end. |
| `timeout_min` | The time limit of the agent, in minutes. The default is 30. |
| `rep` | The repetition number. Use 1, 2 and 3 to do the same config three times. |

The same config always gives the same `run_id`. If `runs/<run_id>/metrics.json` exists, `atg run` does nothing. `--force` does the run again.

## Results

`metrics.json` gives the status, the cost, the tokens, the verdicts and the coverage of a run.

| Status | Meaning |
| --- | --- |
| `ok` | The run finished. This includes an agent that stopped at its turn or budget limit. |
| `agent_error` | The agent failed, for example because of a login error. |
| `infra_error` | atg, the app or the browser failed. The results that atg did not get are `null`. |
| `timeout` | The agent used all of `timeout_min`. atg evaluates the tests that the agent left. |

Each test gets a verdict on each version:

| Version | Verdict | Meaning |
| --- | --- | --- |
| `fixed` | `stable_pass` | The test passes every time. Only these tests can find a bug. |
| `fixed` | `broken` | The test fails every time. |
| `fixed` | `skipped` | The test is skipped every time. |
| `fixed` | `flaky` | The test passes some times and fails some times. |
| `buggy` | `revealing` | The test fails every time. This test finds the bug. |
| `buggy` | `flaky_on_buggy` | The test fails some times. |
| `buggy` | `not_revealing` | The test never fails. |

`caught` is true when one or more tests are `revealing`. `caught_strict` also needs every test to be `stable_pass`, with no two tests that have the same name. The paper has not selected its rule, so atg gives both.

## Apps

Each app has a folder `apps/<id>/` with an `app.json`:

```json
{
  "id": "demo-todo",
  "repo": "repo.bundle",
  "url": "http://localhost:4173",
  "start": "node server.mjs",
  "fixed_ref": "v1.0.0",
  "buggy_ref": "v1.0.0-buggy",
  "code_dir": ".",
  "browser_dir": "public",
  "stories_file": "stories.md",
  "examples_dir": "examples",
  "bugs": [{ "id": "counter", "ref": "v1.0.0-bug-counter", "description": "The left counter also counts todos that are done." }]
}
```

`repo`, `url`, `start`, `fixed_ref` and `buggy_ref` are necessary. atg starts each version of the app with `start` and tests it at `url`. The other fields are optional:

- `code_dir`, `stories_file` and `examples_dir` give the `code`, `task` and `examples` inputs.
- `browser_dir` is the folder of browser code. Without it, atg does not measure line coverage.
- `bugs` lists one version for each bug. atg tests each version, to show which bugs the tests find.

`demo-todo` and `demo-blog` are small apps for the tests and for demos.

## Know before you run

- All versions of an app use the same `url`. Thus, atg does only one run of an app at a time. A second run of the same app waits until the first run is done. Runs of apps with different urls can go at the same time.
- If you stop a run after the agent finished, do not use `atg run` again. It deletes the run folder and calls the agent again. Use `atg eval <run_id>`. It keeps the tests that the agent wrote.
- The agent cannot see your `CLAUDE.md`, your memory or your plugins. It gets no tokens other than its own API key. But atg is not a sandbox. The tests are Node code, and they can read your files.
- Each time the tests run, they have their own limit of `timeout_min`. The evaluation runs them R × (2 + number of bugs) + 1 times. With R = 3, two bugs and 30 minutes, one run can take up to about 6.7 hours.

## Tests

```sh
npm test
npm run typecheck
```

The tests use a fake agent, so they spend no money.

## More details

[docs/reference.md](docs/reference.md) gives every command option, each stage of a run, each file in the run folder, the agent isolation, the coverage tools, the bug-finding rules and the cost pilot.
