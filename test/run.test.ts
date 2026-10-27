import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { basename, join, relative } from "node:path"
import { after, describe, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { holdUrl, startApp } from "../src/app-runtime.ts"
import { findApp, loadApps } from "../src/apps.ts"
import { resolveVersions } from "../src/repo.ts"

const atg = join(import.meta.dirname, "fixtures", "atg.ts")
const demoBundle = join(import.meta.dirname, "..", "apps", "demo-todo", "repo.bundle")
const atgWithFakeCoverage = join(import.meta.dirname, "fixtures", "atg-fake-coverage.ts")
const dir = await mkdtemp(join(tmpdir(), "atg-run-"))
const runs = join(dir, "runs")
after(() => rm(dir, { recursive: true, force: true }))

const base = {
  schema: 1,
  app: "demo-todo",
  inputs: ["url", "task"],
  agent: { name: "fake", model: "suite" },
  framework: "playwright",
  coverage_signal: [],
}

const requiredFiles = [
  "config.json",
  "prompt.md",
  "agent-stdout.txt",
  "agent-stderr.txt",
  "tests/todo.spec.ts",
  "results/fixed/repetitions.json",
  "results/fixed/3-report.json",
  "results/buggy/repetitions.json",
  "results/bugs/repetitions.json",
  "results/bugs/help/3-run.log",
  "results/verdicts.json",
  "results/coverage/summary.json",
  "results/coverage/lines/index.html",
  "env.json",
  "metrics.json",
]

function atgRun(args: string[], env: NodeJS.ProcessEnv = {}, entry = atg) {
  return spawnSync(process.execPath, [entry, "run", "--runs-dir", runs, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
}

function atgIn(runsDir: string, ...args: string[]) {
  return spawnSync(process.execPath, [atg, ...args, "--runs-dir", runsDir], { encoding: "utf8" })
}

async function appsWith(id: string, app: object) {
  const apps = join(dir, "apps")
  await mkdir(join(apps, id), { recursive: true })
  await writeFile(join(apps, id, "app.json"), JSON.stringify({ id, ...app }))
  return apps
}

function runDirIn(apps: string, file: string) {
  const [{ run_id }] = JSON.parse(
    execFileSync(process.execPath, [atg, "validate", "--json", file], {
      encoding: "utf8",
      env: { ...process.env, ATG_APPS_DIR: apps },
    }),
  )
  return join(runs, run_id)
}

async function configFile(name: string, overrides: object) {
  const file = join(dir, name)
  await writeFile(file, JSON.stringify({ ...base, ...overrides }))
  return file
}

function runDirOf(file: string) {
  const [{ run_id }] = JSON.parse(execFileSync(process.execPath, [atg, "validate", "--json", file], { encoding: "utf8" }))
  return join(runs, run_id)
}

async function readJsonFile(file: string) {
  return JSON.parse(await readFile(file, "utf8"))
}

async function agentPids(runDir: string): Promise<number[]> {
  return JSON.parse((await readFile(join(runDir, "agent-stdout.txt"), "utf8")).split("\n")[0]).pids
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function atgTempDirs() {
  return (await readdir(tmpdir())).filter(entry => /^atg-(workspace|app|repo|suite|source|signal)-/.test(entry))
}

async function appAnswers() {
  return fetch("http://localhost:4173", { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  )
}

describe("atg run with a fake agent", () => {
  test("goes through every stage, runs the suite R times on each version and classifies each test", async () => {
    const file = await configFile("suite.json", {})
    const result = atgRun([file])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const runDir = runDirOf(file)
    for (const name of requiredFiles) assert.ok(existsSync(join(runDir, name)), `${name} is missing`)
    const metrics = await readJsonFile(join(runDir, "metrics.json"))
    assert.equal(metrics.status, "ok")
    assert.equal(metrics.n_tests, 3)
    assert.deepEqual(metrics.evaluation, { protocol: 1, reruns: 3 })
    assert.deepEqual(metrics.fixed, { stable_pass: 2, broken: 1, flaky: 0, skipped: 0 })
    assert.deepEqual(metrics.buggy, { revealing: 1, flaky_on_buggy: 0, not_revealing: 1 })
    assert.equal(metrics.caught, true)
    assert.equal(metrics.caught_strict, false)
    assert.equal(metrics.not_caught_reason, null)
    assert.deepEqual(metrics.bugs, {
      tested: 2,
      detected: 1,
      detection_rate: 0.5,
      by_bug: {
        counter: { revealing: 1, flaky_on_buggy: 0, not_revealing: 1 },
        help: { revealing: 0, flaky_on_buggy: 0, not_revealing: 2 },
      },
    })
    assert.deepEqual(Object.keys(metrics.wall_ms), ["prepare", "generate", "fixed", "buggy", "bugs", "coverage"])
    const { fixed, buggy, bugs } = metrics.repetition_ms
    for (const runs of [fixed, buggy, bugs.counter, bugs.help]) assert.equal(runs.length, 3)
    assert.deepEqual(await readJsonFile(join(runDir, "results", "verdicts.json")), {
      duplicates: [],
      tests: [
        {
          key: "todo.spec.ts › adds a todo",
          fixed: "stable_pass",
          buggy: "not_revealing",
          bugs: { counter: "not_revealing", help: "not_revealing" },
        },
        {
          key: "todo.spec.ts › counts what is left after a todo is done",
          fixed: "stable_pass",
          buggy: "revealing",
          bugs: { counter: "revealing", help: "not_revealing" },
        },
        { key: "todo.spec.ts › fails on purpose", fixed: "broken" },
      ],
    })
    assert.deepEqual(metrics.coverage, {
      lines: { covered: 20, total: 27, pct: 74.07, report: "results/coverage/lines/index.html" },
      html: null,
      api: null,
    })
    assert.equal(metrics.signal_calls, 0)
    const { lines } = await readJsonFile(join(runDir, "results", "coverage", "summary.json"))
    assert.ok(lines.uncovered.includes("public/help.js: 0.00 % of lines covered, uncovered lines 1-6"), lines.uncovered)
    assert.doesNotMatch(await readFile(join(runDir, "prompt.md"), "utf8"), /coverage/)
    const env = await readJsonFile(join(runDir, "env.json"))
    assert.match(env.app.fixed.sha, /^[0-9a-f]{40}$/)
    assert.notEqual(env.app.fixed.sha, env.app.buggy.sha)
    assert.deepEqual(env.evaluation, { protocol: 1, reruns: 3 })
    assert.deepEqual(env.bugs, [
      { id: "counter", ref: "v1.0.0-bug-counter", sha: "b093525ac628b7701a402bb664306f553fbd1c2c" },
      { id: "help", ref: "v1.0.0-bug-help", sha: "3784d91782f3e4ed0d86341b35a935614d46d9f4" },
    ])
    assert.ok(env.framework.versions.chromium)
    assert.equal(existsSync(env.workspace), false, "the workspace is removed")
    assert.equal(await appAnswers(), false)
  })

  test("eval --reruns 1 records the new R in metrics and env, and keeps the run_id", async () => {
    const runDir = runDirOf(await configFile("suite.json", {}))
    const before = await readJsonFile(join(runDir, "metrics.json"))
    const result = atgIn(runs, "eval", basename(runDir), "--reruns", "1")
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, new RegExp(`^run_id ${basename(runDir)}$`, "m"))
    const metrics = await readJsonFile(join(runDir, "metrics.json"))
    assert.deepEqual(metrics.evaluation, { protocol: 1, reruns: 1 })
    assert.deepEqual((await readJsonFile(join(runDir, "env.json"))).evaluation, { protocol: 1, reruns: 1 })
    assert.equal(metrics.repetition_ms.fixed.length, 1)
    assert.deepEqual([metrics.fixed, metrics.buggy, metrics.bugs], [before.fixed, before.buggy, before.bugs])
    assert.deepEqual(await readdir(runs), [basename(runDir)])
  })

  test("is a no-op when it is done, also with another R, and --force redoes it", async () => {
    const file = await configFile("suite.json", {})
    const metrics = join(runDirOf(file), "metrics.json")
    const before = statSync(metrics).mtimeMs
    const again = atgRun([file, "--reruns", "2"])
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /is done, nothing to do/)
    assert.equal(statSync(metrics).mtimeMs, before)
    const forced = atgRun([file, "--force", "--reruns", "1"])
    assert.equal(forced.status, 0, forced.stdout + forced.stderr)
    assert.notEqual(statSync(metrics).mtimeMs, before)
    assert.equal((await readJsonFile(metrics)).status, "ok")
  })

  test("eval --only coverage reproduces the coverage from the saved tests without calling the agent", async () => {
    const runDir = runDirOf(await configFile("suite.json", {}))
    const before = await readJsonFile(join(runDir, "metrics.json"))
    const agentOutput = statSync(join(runDir, "agent-stdout.txt")).mtimeMs
    const result = atgIn(runs, "eval", basename(runDir), "--only", "coverage")
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /coverage: lines 74\.07%, html not measured, api not measured/)
    const after = await readJsonFile(join(runDir, "metrics.json"))
    assert.deepEqual(after.coverage, before.coverage)
    assert.deepEqual(after.fixed, before.fixed)
    assert.equal(after.wall_ms.fixed, before.wall_ms.fixed)
    assert.equal(statSync(join(runDir, "agent-stdout.txt")).mtimeMs, agentOutput)
    const unfinished = atgIn(runs, "eval", "not-a-run")
    assert.equal(unfinished.status, 1)
    assert.match(unfinished.stderr, /run not-a-run has no suite to evaluate: its generate stage did not finish/)
  })

  test("eval --only buggy reuses the saved fixed results, also when a killed run left no metrics.json, and errors without them", async () => {
    const runDir = runDirOf(await configFile("suite.json", {}))
    const fixedResults = join(runDir, "results", "fixed", "repetitions.json")
    const saved = statSync(fixedResults).mtimeMs
    const before = await readJsonFile(join(runDir, "metrics.json"))
    const result = atgIn(runs, "eval", basename(runDir), "--only", "buggy", "--reruns", "1")
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.equal(statSync(fixedResults).mtimeMs, saved)
    const after = await readJsonFile(join(runDir, "metrics.json"))
    assert.notEqual(after.wall_ms.buggy, before.wall_ms.buggy)
    assert.deepEqual([after.fixed, after.buggy, after.caught], [before.fixed, before.buggy, true])

    const copies = join(dir, "copies")
    await cp(runDir, join(copies, basename(runDir)), { recursive: true })
    await rm(join(copies, basename(runDir), "metrics.json"))
    const otherR = atgIn(copies, "eval", basename(runDir), "--only", "buggy")
    assert.equal(otherR.status, 1)
    assert.match(otherR.stdout, /^error buggy: the saved fixed results come from --reruns 1, not 3: give --reruns 1/m)
    await rm(join(copies, basename(runDir), "results", "fixed"), { recursive: true })
    const unsaved = atgIn(copies, "eval", basename(runDir), "--only", "buggy", "--reruns", "1")
    assert.equal(unsaved.status, 1)
    assert.match(unsaved.stdout, /^error buggy: there are no saved fixed results, run the fixed stage first$/m)
    const metrics = await readJsonFile(join(copies, basename(runDir), "metrics.json"))
    assert.equal(metrics.status, "infra_error")
    assert.deepEqual([metrics.fixed, metrics.buggy, metrics.caught], [null, null, null])
  })

  test("pilot reports one run, its bug finding and evaluation time, and extrapolates them to the full grid", async () => {
    const runDir = runDirOf(await configFile("suite.json", {}))
    const metrics = await readJsonFile(join(runDir, "metrics.json"))
    const result = atgIn(runs, "pilot", basename(runDir), "--concurrency", "4")
    assert.equal(result.status, 0, result.stderr)
    const time = String.raw`[\d.]+ s`
    for (const row of [
      /^Run `demo-todo__fake__playwright__\w+`: fake suite, inputs task, url, coverage_signal none, playwright, rep 1, max_budget_usd none\. Status ok \(success\)\.$/m,
      new RegExp(`^\\| Wall time \\| prepare ${time}, generate ${time}, fixed ${time}, buggy ${time}, bugs ${time}, coverage ${time}; total ${time} \\|$`, "m"),
      /^\| Tokens \| input 10, output 20, cache read 0, cache creation 0 \|$/m,
      /^\| Cost \| \$0\.00 \(fake\) \|$/m,
      /^\| Turns \| 3 \|$/m,
      /^\| Coverage \| lines 74\.07% \(20 of 27\), html not measured, api not measured \|$/m,
      /^## Bug finding$/m,
      /^\| Repetitions \| 1 per version, evaluation protocol 1 \|$/m,
      /^\| Tests on fixed \| 3 tests: 2 stable_pass, 1 broken, 0 flaky, 0 skipped \|$/m,
      /^\| Tests on buggy \| 1 revealing, 0 flaky_on_buggy, 1 not_revealing \|$/m,
      /^\| Caught \| caught true, caught_strict false \|$/m,
      /^\| Per-bug detection \| 1 of 2 bugs \(50%\): counter 1 revealing, help 0 revealing \|$/m,
      new RegExp(`^\\| Evaluation time \\| fixed ${time}, buggy ${time}, bugs ${time}, coverage ${time}; total ${time} \\|$`, "m"),
      new RegExp(`^\\| One repetition \\| fixed ${time}, buggy ${time}, bugs/counter ${time}, bugs/help ${time} \\(mean of each version\\) \\|$`, "m"),
      /^## Full grid of 11,520 runs$/m,
      /^\| Total cost \| \$0\.00 \| Every run costs what this run cost: \$0\.00 \(fake\)\. \|$/m,
      /each does 3,840 runs with 4 at a time/,
    ]) {
      assert.match(result.stdout, row)
    }
    const hours = (ms: number) => ((ms * 11_520) / 3_600_000).toFixed(1)
    assert.match(result.stdout, new RegExp(`^\\| Agent-hours \\| ${hours(metrics.wall_ms.generate)} h \\|`, "m"))
    const { fixed, buggy, bugs, coverage } = metrics.wall_ms
    const evaluationHours = hours(fixed + buggy + bugs + coverage)
    assert.match(result.stdout, new RegExp(`^\\| Evaluation-hours \\| R=1 ${evaluationHours} h, R=3 [\\d.]+ h, R=5 [\\d.]+ h \\|`, "m"))
  })

  test("with coverage_signal [lines] and no url input, the app runs only during each counted signal call", async () => {
    const file = await configFile("signal.json", {
      agent: { name: "fake", model: "signal" },
      inputs: ["task"],
      coverage_signal: ["lines"],
    })
    const result = atgRun([file, "--reruns", "1"])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const runDir = runDirOf(file)
    assert.match(await readFile(join(runDir, "prompt.md"), "utf8"), /Run `\.\/coverage` to measure your current tests/)
    const agentOutput = await readFile(join(runDir, "agent-stdout.txt"), "utf8")
    assert.match(agentOutput, /^app answers false$/m)
    assert.match(agentOutput, /^Browser-side line coverage: 74\.07% \(20 of 27\)$/m)
    assert.match(agentOutput, /^ {2}public\/help\.js: 0\.00 % of lines covered, uncovered lines 1-6$/m)
    const metrics = await readJsonFile(join(runDir, "metrics.json"))
    assert.equal(metrics.status, "ok")
    assert.equal(metrics.signal_calls, 1)
    assert.equal(metrics.coverage.lines.pct, 74.07)
    assert.deepEqual((await readdir(runDir)).toSorted(), [
      "agent-stderr.txt",
      "agent-stdout.txt",
      "agent.json",
      "app-generate.log",
      "app-signal.log",
      "config.json",
      "env.json",
      "metrics.json",
      "prompt.md",
      "results",
      "signal-calls.jsonl",
      "stages.json",
      "tests",
    ])
  })

  test("a fake adapter registered in place of a stub shows up in metrics with no change to core", async () => {
    const file = await configFile("fake-coverage.json", {
      agent: { name: "fake", model: "signal" },
      coverage_signal: ["lines"],
      rep: 2,
    })
    const result = atgRun([file, "--reruns", "1"], {}, atgWithFakeCoverage)
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const runDir = runDirOf(file)
    const metrics = await readJsonFile(join(runDir, "metrics.json"))
    assert.deepEqual(metrics.coverage.html, { covered: 1, total: 2, pct: 50, report: "results/coverage/html/universe.json" })
    assert.equal(metrics.coverage.lines.pct, 74.07)
    assert.equal(metrics.coverage.api, null)
    assert.doesNotMatch(await readFile(join(runDir, "agent-stdout.txt"), "utf8"), /Fake pages visited/)
  })

  test("killed mid-run, it leaves no process behind and a re-run starts clean", async () => {
    const file = await configFile("slow.json", { agent: { name: "fake", model: "slow" }, inputs: ["url"] })
    const runDir = runDirOf(file)
    const tempBefore = await atgTempDirs()
    const child = spawn(process.execPath, [atg, "run", "--runs-dir", runs, file], { stdio: "ignore" })
    const exited = new Promise(resolve => child.once("exit", resolve))
    const stdout = join(runDir, "agent-stdout.txt")
    for (let tries = 0; !existsSync(stdout) || (await readFile(stdout, "utf8")) === ""; tries++) {
      assert.ok(tries < 200, "the agent never started")
      await sleep(50)
    }
    assert.equal(await appAnswers(), true, "the app runs while the agent works")
    child.kill("SIGTERM")
    await exited
    const pids = await agentPids(runDir)
    assert.deepEqual(pids.filter(alive), [])
    assert.equal(await appAnswers(), false)
    assert.equal(existsSync(join(runDir, "metrics.json")), false)
    assert.equal(existsSync((await readJsonFile(join(runDir, "env.json"))).workspace), false)
    assert.deepEqual((await atgTempDirs()).filter(entry => !tempBefore.includes(entry)), [])
    await writeFile(join(runDir, "stale.txt"), "from the killed run")

    const rerun = atgRun([file, "--reruns", "1"])
    assert.equal(rerun.status, 0, rerun.stdout + rerun.stderr)
    assert.equal(existsSync(join(runDir, "stale.txt")), false)
    assert.equal((await readJsonFile(join(runDir, "metrics.json"))).status, "ok")
  })

  test("an agent that hangs past timeout_min gives timeout, kills its tree and keeps its tests", async () => {
    const file = await configFile("hang.json", {
      agent: { name: "fake", model: "hang" },
      inputs: ["code"],
      timeout_min: 0.1,
    })
    const result = atgRun([file, "--reruns", "1"])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const runDir = runDirOf(file)
    const metrics = await readJsonFile(join(runDir, "metrics.json"))
    assert.equal(metrics.status, "timeout")
    assert.equal(metrics.stop_reason, "timeout_min")
    assert.deepEqual(metrics.fixed, { stable_pass: 1, broken: 0, flaky: 0, skipped: 0 })
    const pids = await agentPids(runDir)
    assert.equal(pids.length, 2)
    assert.deepEqual(pids.filter(alive), [])
    assert.equal(await appAnswers(), false)
  })

  test("a broken start command gives infra_error and the agent is never called", async () => {
    const apps = await appsWith("broken", {
      repo: demoBundle,
      url: "http://localhost:4174",
      start: "exit 3",
      fixed_ref: "v1.0.0",
      buggy_ref: "v1.0.0-buggy",
    })
    const file = await configFile("broken.json", { app: "broken", inputs: [] })
    const result = atgRun([file], { ATG_APPS_DIR: apps })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    const runDir = runDirIn(apps, file)
    const metrics = await readJsonFile(join(runDir, "metrics.json"))
    assert.equal(metrics.status, "infra_error")
    assert.match(metrics.error, /^generate: app "broken" did not start: the start command exited with code 3/)
    assert.equal(existsSync(join(runDir, "agent-stdout.txt")), false)
    assert.equal(metrics.fixed, null)
  })

  test("a buggy version whose start command fails gives infra_error, and is neither caught nor not caught", async () => {
    const repo = join(dir, "broken-buggy-repo")
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.name=atg", "-c", "user.email=atg@example.invalid", ...args])
    execFileSync("git", ["clone", "-q", demoBundle, repo])
    await writeFile(join(repo, "server.mjs"), "process.exit(3)\n")
    git("commit", "-qam", "break the start")
    git("tag", "broken")
    const apps = await appsWith("broken-buggy", {
      repo,
      url: "http://localhost:4173",
      start: "node server.mjs",
      fixed_ref: "v1.0.0",
      buggy_ref: "broken",
    })
    const file = await configFile("broken-buggy.json", { app: "broken-buggy", inputs: [] })
    const result = atgRun([file, "--reruns", "1"], { ATG_APPS_DIR: apps })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    const metrics = await readJsonFile(join(runDirIn(apps, file), "metrics.json"))
    assert.equal(metrics.status, "infra_error")
    assert.match(metrics.error, /^buggy: app "broken-buggy" did not start: the start command exited with code 3/)
    assert.deepEqual(metrics.fixed, { stable_pass: 2, broken: 1, flaky: 0, skipped: 0 })
    assert.deepEqual([metrics.buggy, metrics.caught, metrics.caught_strict, metrics.bugs], [null, null, null, null])
    assert.equal(await appAnswers(), false)
  })

  test("a flaky test is flaky and never revealing, a test that always fails is broken, and an anonymous describe is no problem", async () => {
    const file = await configFile("flaky.json", { agent: { name: "fake", model: "flaky" } })
    const result = atgRun([file, "--reruns", "2"], { FLAKY_COUNTER: join(dir, "flaky-counter") })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const runDir = runDirOf(file)
    const metrics = await readJsonFile(join(runDir, "metrics.json"))
    assert.equal(metrics.status, "ok")
    assert.deepEqual(metrics.fixed, { stable_pass: 2, broken: 1, flaky: 1, skipped: 0 })
    assert.deepEqual(metrics.buggy, { revealing: 1, flaky_on_buggy: 0, not_revealing: 1 })
    assert.equal(metrics.caught, true)
    assert.equal(metrics.caught_strict, false)
    const { tests } = await readJsonFile(join(runDir, "results", "verdicts.json"))
    assert.deepEqual(
      tests.filter((test: { fixed: string }) => test.fixed !== "stable_pass"),
      [
        { key: "todo.spec.ts › fails on purpose", fixed: "broken" },
        { key: "todo.spec.ts › fails on every second run", fixed: "flaky" },
      ],
    )
    const counts = tests.find((test: { key: string }) => test.key === "todo.spec.ts ›  › counts what is left after a todo is done")
    assert.equal(counts?.buggy, "revealing")
  })

  test("a suite with no stable_pass test is ok, with caught false and the reason", async () => {
    const file = await configFile("no-stable.json", { agent: { name: "fake", model: "broken" } })
    const result = atgRun([file, "--reruns", "1"])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const metrics = await readJsonFile(join(runDirOf(file), "metrics.json"))
    assert.equal(metrics.status, "ok")
    assert.deepEqual(metrics.fixed, { stable_pass: 0, broken: 1, flaky: 0, skipped: 0 })
    assert.deepEqual(metrics.buggy, { revealing: 0, flaky_on_buggy: 0, not_revealing: 0 })
    assert.equal(metrics.caught, false)
    assert.equal(metrics.caught_strict, false)
    assert.equal(metrics.not_caught_reason, "no test is stable_pass on fixed")
    assert.deepEqual([metrics.bugs.tested, metrics.bugs.detected], [2, 0])
    assert.deepEqual([metrics.repetition_ms.buggy, metrics.repetition_ms.bugs], [[], { counter: [], help: [] }])
  })
})

describe("app runtime", () => {
  test("a stopped instance no longer answers, so the next one starts on the same url", async () => {
    const app = findApp(await loadApps(), "demo-todo")
    const { fixed } = await resolveVersions(app)
    for (const n of [1, 2, 3]) {
      const instance = await startApp(app, fixed, join(dir, `instance-${n}.log`))
      assert.equal(await appAnswers(), true)
      await instance.stop()
      assert.equal(await appAnswers(), false)
    }
  })

  test("a second hold on the same url waits until the first is released", async () => {
    const release = await holdUrl("http://localhost:4199")
    let held = false
    const second = holdUrl("http://localhost:4199/other").then(next => {
      held = true
      return next
    })
    await sleep(1200)
    assert.equal(held, false)
    await release()
    await (await second)()
    assert.equal(held, true)
  })
})

describe("atg run --dry-run on a real agent config", () => {
  test("prints the exact invocation and builds a workspace with only the selected inputs", async t => {
    const file = await configFile("claude.json", {
      agent: { name: "claude", model: "claude-opus-5-5", max_turns: 30 },
      inputs: ["code", "task"],
    })
    const result = atgRun([file, "--dry-run"])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /claude -p --output-format json --model claude-opus-5-5 --max-turns 30 --permission-mode dontAsk/)
    assert.match(result.stdout, /'Bash\(npx playwright test \*\)' --no-session-persistence --strict-mcp-config (--bare|--setting-sources '')/)
    assert.match(result.stdout, / < \S+prompt\.md$/m)
    const workspace = result.stdout.match(/^workspace (.+)$/m)?.[1] ?? assert.fail("no workspace printed")
    t.after(() => rm(workspace, { recursive: true, force: true }))
    assert.ok(relative(homedir(), workspace).startsWith(".."), "the workspace is outside the home folder")

    const entries = await readdir(workspace, { recursive: true })
    assert.deepEqual(entries.filter(entry => entry.includes(".git")), [])
    assert.deepEqual(
      entries.filter(entry => !entry.startsWith("node_modules")).toSorted(),
      [
        "code",
        "code/public",
        "code/public/app.js",
        "code/public/help.html",
        "code/public/help.js",
        "code/public/index.html",
        "code/public/style.css",
        "code/server.mjs",
        "package.json",
        "playwright.config.ts",
        "stories.md",
        "tests",
      ],
    )
    assert.match(await readFile(join(workspace, "code", "public", "app.js"), "utf8"), /input:not\(:checked\)/)
    assert.doesNotMatch(result.stdout, /coverage/)
    assert.doesNotMatch(await readFile(join(workspace, "playwright.config.ts"), "utf8"), /localhost/)
    const runDir = runDirOf(file)
    const prompt = await readFile(join(runDir, "prompt.md"), "utf8")
    assert.doesNotMatch(prompt, /localhost|examples/)
    assert.match(prompt, /`stories\.md`[\s\S]*`code\/`/)
    assert.equal(existsSync(join(runDir, "agent-stdout.txt")), false)
    assert.equal(existsSync(join(runDir, "metrics.json")), false)
  })

  test("with a coverage signal, the workspace gets the signal command and the agent may run it", async t => {
    const file = await configFile("claude-signal.json", {
      agent: { name: "claude", model: "claude-opus-5-5" },
      coverage_signal: ["lines"],
    })
    const result = atgRun([file, "--dry-run"])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /'Bash\(npx playwright test \*\)' 'Bash\(\.\/coverage\)' 'Bash\(\.\/coverage \*\)'/)
    const workspace = result.stdout.match(/^workspace (.+)$/m)?.[1] ?? assert.fail("no workspace printed")
    t.after(() => rm(workspace, { recursive: true, force: true }))
    const command = join(workspace, "coverage")
    assert.equal(statSync(command).mode & 0o111, 0o111, "the signal command is executable")
    assert.match(await readFile(command, "utf8"), new RegExp(` signal ${runDirOf(file)}\n$`))
    assert.match(await readFile(join(runDirOf(file), "prompt.md"), "utf8"), /Run `\.\/coverage`/)
  })

  test("refuses a workspace inside the home folder, where parent CLAUDE.md files would reach the agent", async () => {
    const home = join(dir, "home")
    await mkdir(join(home, "tmp"), { recursive: true })
    const file = await configFile("claude-home.json", { agent: { name: "claude", model: "claude-opus-5-5" } })
    const result = atgRun([file, "--dry-run"], { HOME: home, TMPDIR: join(home, "tmp") })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    assert.match(result.stderr, /prepare failed: the workspace \S+ is inside \S+, set TMPDIR to a folder outside it/)
    assert.deepEqual(await readdir(join(home, "tmp")), [])
  })
})
