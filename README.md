# atg

Agentic test generation. atg benchmarks coding agents (Claude Code, Codex CLI, Gemini CLI) that write E2E test suites (Playwright, Selenium, Cypress) for web apps.

This step defines the run config and creates configs. Later steps run the agents and the tests.

## Setup

You need Node 24 or later. Node runs the TypeScript sources directly, so there is no build step.

```sh
npm install
npm link        # optional: puts `atg` on your PATH
node src/cli.ts --help
```

## Commands

| Command | What it does |
| --- | --- |
| `atg validate <config...> [--json]` | Checks each config file. Prints the normalized config and its `run_id`, or readable errors. Exits with 1 if a file is not valid. |
| `atg schema [--out <file>]` | Prints the config JSON Schema. |
| `atg apps [--json]` | Lists the apps and the inputs each app provides. |
| `atg new [--out <file>] [--from <config>]` | Creates a config with an interactive wizard. `--from` prefills the answers from a config. Without `--out`, the file is `<run_id>.json`. Ctrl+C writes nothing. |

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
| `timeout_min` | Minutes. Default `30`. |
| `rep` | Repetition index, a positive integer. Default `1`. |

Unknown keys are errors. A subset must not repeat an item.

### `coverage_signal` is the treatment, not the measurement

`coverage_signal` sets only the coverage that the agent sees as feedback while it works. Evaluation always measures all three coverage tools (`lines`, `html`, `api`), for every run. An empty `coverage_signal` means "no feedback". It does not mean "no measurement".

### Normalization and `run_id`

Before any other step, atg normalizes a config: it applies the defaults and sorts `inputs` and `coverage_signal`. Two equivalent configs give the same bytes.

`run_id` is `<app>__<agent>__<framework>__<hash8>`. The hash is SHA-256 over the normalized config (`rep` included) and the app's `fixed_ref` and `buggy_ref`. There is no timestamp. The same content gives the same `run_id`, so a later step can resume a run. Different content gives a different `run_id`.

## Apps

Each app has a folder `apps/<id>/` with an `app.json`. The `id` must be the folder name.

| Field | Gives the input |
| --- | --- |
| `url` | `url` |
| `start` (command that starts the app) | |
| `stories_file` | `task` |
| `examples_dir` | `examples` |
| `code_dir` | `code` |
| `fixed_ref`, `buggy_ref` (required) | |

An app needs `url` or `start`. Paths are relative to the app folder. Two example apps are fixtures for tests and demos: `demo-todo` provides all inputs, `demo-blog` has no code.

## Registries

`src/registries.ts` holds the agents, frameworks and coverage tools as named descriptors (`name`, `label`, `implemented`). The rest of the code does not name a specific agent, framework or coverage tool. The wizard shows options that are not implemented, but you cannot select them. `atg validate` accepts every registry name.

## Tests

```sh
npm test
npm run typecheck
```
