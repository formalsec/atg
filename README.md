# atg

atg measures how well a coding agent writes end-to-end tests for a web app. atg gives Claude Code a new, empty folder and the inputs that a config selects, and Claude Code writes Playwright tests. Then atg runs the tests R times on the correct version of the app (`fixed`). It also runs them on a version with known bugs (`buggy`) and on one version for each bug. A test that passes every time on `fixed` and fails every time on `buggy` finds the bug. atg also measures the lines of browser code that the tests run, the API endpoints that they call and the interactive HTML elements that they act on. All results go to `runs/<run_id>/`.

## Commands

You need Node 24 or later. There is no build step.

```sh
npm install
npx playwright install --only-shell chromium
npm test
```

| Command | What it does |
| --- | --- |
| `atg run <config>` | Does one run: Claude Code writes the tests, then atg evaluates them and writes `metrics.json`. |
| `atg run <config> --dry-run` | Makes sure that the config is correct, prepares the workspace and the prompt, and prints the `run_id` and the agent command. It does not call the agent. |
| `atg eval <run_id>` | Evaluates the saved tests of a run again, without the agent. `--only <stage>` does one stage: `fixed`, `buggy`, `bugs` or `coverage`. |
| `atg signal <run_dir>` | Runs the workspace tests of a run on the fixed app and prints the coverage that `coverage_signal` selects. The agent uses it through `./coverage`. |
| `atg pilot <run_id>` | Prints the cost of one run and an estimate for the full grid of 11,520 runs. |

`--reruns <n>` on `run` and `eval` sets R. The default is 3. `atg <command> --help` shows all options. To put `atg` on your PATH, run `npm link`.

- If `runs/<run_id>/metrics.json` exists, `atg run` does nothing. `--force` does the run again.
- If a run stops after the agent finished, use `atg eval <run_id>`. `atg run` deletes the run folder and calls the agent again.
- All versions of an app use the same `url`. Thus, a second run of an app waits until the first run is done.
- The agent cannot see your `CLAUDE.md`, your memory or your plugins. But atg is not a sandbox: the tests are Node code, and they can read your files.

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
| `app` | A folder in `apps/`. Each app has an `app.json`, for example `apps/demo-todo/app.json`. |
| `inputs` | What the agent gets: `url` (the running app), `task` (user stories), `examples` (example tests) and `code` (source code). The list can be empty. |
| `agent` | `name` is `claude`. `model` is the Claude model. `max_turns` and `max_budget_usd` are optional limits. |
| `framework` | `playwright`. |
| `coverage_signal` | `lines` lets the agent see its line coverage while it works. `api` lets it see its API endpoint coverage and the endpoints that it did not call. `html` lets it see its HTML element coverage and the elements that it did not act on. `[]` hides all. atg always measures all at the end. |
| `timeout_min` | The time limit of the agent, in minutes. The default is 30. |
| `rep` | The repetition number. Use 1, 2 and 3 to do the same config three times. |

The `run_id` is `<app>__claude__playwright__<hash>`. The hash comes from the config, the commits of the fixed and buggy versions, and the prompt template `src/prompt.md`. Thus, the same config always gives the same `run_id`.

## API coverage

The `endpoints` list in `app.json` is the denominator, for example `"PATCH /api/todos/{id}"`. During the `coverage` stage, atg records each request that the browser sends. Then it puts each request into one group:

- `covered`: the method is the same and the path matches the template. `{id}` matches one path segment. The query is not used. If a path matches two templates, the template with fewer parameters wins, so `/users/me` wins over `/users/{id}`.
- `ignored`: a request to another origin, a request that the app did not answer (`page.route` answered it, it failed, or it had no response before the test ended), or a GET of a page or an asset (document, script, stylesheet, image, font, media) that matches no endpoint. Each item shows why.
- `unmatched`: every other request. If this list is not empty, the `endpoints` list can be incomplete.

`api/report.json` lists all groups and the endpoints that are not covered. atg counts only the requests that a browser page sends. Requests from the `request` fixture of Playwright are not counted.

## HTML element coverage

The denominator is the elements with an interactive role in the ARIA snapshots (Playwright `ariaSnapshotJSON`) of the `coverage` stage. atg takes a snapshot before each action and when each test ends. Thus the denominator comes from the suite: if no test opens a page, the elements of that page are not in it. The interactive roles are the WAI-ARIA 1.2 widget roles that a user operates: button, checkbox, combobox, link, listbox, menuitem, menuitemcheckbox, menuitemradio, radio, searchbox, slider, spinbutton, switch, tab, textbox and treeitem.

- An element is its route (the path, without query or hash), its role and its accessible name, for example `/ button "Clear"`. `getByRole` uses the same identity.
- Inside a list item or a table row, the name is not used. The element is the item role, its role and its position in the item, for example `/ listitem › checkbox 1`. Thus all rows are one row, and the titles that a test types do not add elements.
- An element is covered when one of these actions on it succeeds, from a locator or from `page`: `check`, `uncheck`, `setChecked`, `click`, `dblclick`, `tap`, `fill`, `clear`, `press`, `pressSequentially`, `selectOption`, `setInputFiles` and `dragTo`. Playwright finds the target, so a CSS, text or role locator gives the same element. If the target has no interactive role, the action counts for its nearest interactive ancestor, or else for its only interactive descendant, for example the checkbox in a label.
- These do not count: `page.mouse` and `page.keyboard`, element handles, trial actions, failed actions and other origins. atg does not see a click listener on an element that has no interactive role, for example a `div` with `onclick`. For this reason, the help questions of demo-todo are buttons.

`html/report.json` gives these rules, the covered and uncovered elements of each route, and the actions that atg could not connect to an element (`ignored`).

## Run folder

| File | Content |
| --- | --- |
| `config.json` | The config, with its defaults. |
| `prompt.md` | The prompt that the agent got. |
| `env.json` | The versions of atg, Node, the OS, Claude Code, Playwright and Chromium, the app commits, the agent command, R and the start and end times. |
| `stages.json` | The time and the error of each stage. |
| `agent.json`, `agent-stdout.txt`, `agent-stderr.txt` | The agent result and its output. |
| `tests/` | The tests that the agent wrote. |
| `results/fixed/`, `results/buggy/`, `results/bugs/<id>/` | The result of each repetition on each version, with its reports and logs. |
| `results/verdicts.json` | The verdict of each test on each version. |
| `results/coverage/` | The line coverage report, the API report `api/report.json`, the HTML element report `html/report.json` and `summary.json`. |
| `signal-calls.jsonl` | One line for each time that the agent used `./coverage`. |
| `metrics.json` | The status, the cost, the tokens, the times, the verdict counts, `caught`, `caught_strict`, the bugs found and the coverage. atg writes it last. |

| Status | Meaning |
| --- | --- |
| `ok` | The run finished. This includes an agent that stopped at its turn or budget limit. |
| `agent_error` | The agent failed, for example because of a login error. |
| `infra_error` | atg, the app or the browser failed. The results that atg did not get are `null`. |
| `timeout` | The agent used all of `timeout_min`. atg evaluates the tests that the agent left. |

| Version | Verdict | Meaning |
| --- | --- | --- |
| `fixed` | `stable_pass` | The test passes every time. Only these tests can find a bug. |
| `fixed` | `broken` | The test fails every time. |
| `fixed` | `skipped` | The test is skipped every time. |
| `fixed` | `flaky` | The test passes some times and fails some times. |
| `buggy` | `revealing` | The test fails every time. This test finds the bug. |
| `buggy` | `flaky_on_buggy` | The test fails some times. |
| `buggy` | `not_revealing` | The test never fails. |

`caught` is true when one or more tests are `revealing`. `caught_strict` also needs every test to be `stable_pass`, with no two tests that have the same name. The rule for the paper is not decided, so atg gives both.
