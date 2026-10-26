import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, relative } from "node:path"
import { after, describe, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"

const atg = join(import.meta.dirname, "fixtures", "atg.ts")
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
  "results/fixed.json",
  "env.json",
  "metrics.json",
]

function atgRun(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [atg, "run", "--runs-dir", runs, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
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
  return (await readdir(tmpdir())).filter(entry => /^atg-(workspace|app|repo|suite)-/.test(entry))
}

async function appAnswers() {
  return fetch("http://localhost:4173", { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  )
}

describe("atg run with a fake agent", () => {
  test("goes through every stage and evaluates the suite on the fixed version", async () => {
    const file = await configFile("suite.json", {})
    const result = atgRun([file])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const runDir = runDirOf(file)
    for (const name of requiredFiles) assert.ok(existsSync(join(runDir, name)), `${name} is missing`)
    const metrics = await readJsonFile(join(runDir, "metrics.json"))
    assert.equal(metrics.status, "ok")
    assert.equal(metrics.n_tests, 3)
    assert.deepEqual(metrics.fixed, { passed: 2, failed: 1, flaky: 0, skipped: 0 })
    assert.deepEqual(Object.keys(metrics.wall_ms), ["prepare", "generate", "evaluate"])
    const env = await readJsonFile(join(runDir, "env.json"))
    assert.match(env.app.fixed.sha, /^[0-9a-f]{40}$/)
    assert.notEqual(env.app.fixed.sha, env.app.buggy.sha)
    assert.ok(env.framework.versions.chromium)
    assert.equal(existsSync(env.workspace), false, "the workspace is removed")
    assert.equal(await appAnswers(), false)
  })

  test("is a no-op when it is done, and --force redoes it", async () => {
    const file = await configFile("suite.json", {})
    const metrics = join(runDirOf(file), "metrics.json")
    const before = statSync(metrics).mtimeMs
    const again = atgRun([file])
    assert.equal(again.status, 0, again.stderr)
    assert.match(again.stdout, /is done, nothing to do/)
    assert.equal(statSync(metrics).mtimeMs, before)
    const forced = atgRun([file, "--force"])
    assert.equal(forced.status, 0, forced.stdout + forced.stderr)
    assert.notEqual(statSync(metrics).mtimeMs, before)
    assert.equal((await readJsonFile(metrics)).status, "ok")
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

    const rerun = atgRun([file])
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
    const result = atgRun([file])
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const runDir = runDirOf(file)
    const metrics = await readJsonFile(join(runDir, "metrics.json"))
    assert.equal(metrics.status, "timeout")
    assert.equal(metrics.stop_reason, "timeout_min")
    assert.deepEqual(metrics.fixed, { passed: 1, failed: 0, flaky: 0, skipped: 0 })
    const pids = await agentPids(runDir)
    assert.equal(pids.length, 2)
    assert.deepEqual(pids.filter(alive), [])
    assert.equal(await appAnswers(), false)
  })

  test("a broken start command gives infra_error and the agent is never called", async () => {
    const apps = join(dir, "apps")
    await mkdir(join(apps, "broken"), { recursive: true })
    await writeFile(
      join(apps, "broken", "app.json"),
      JSON.stringify({
        id: "broken",
        repo: join(import.meta.dirname, "..", "apps", "demo-todo", "repo.bundle"),
        url: "http://localhost:4174",
        start: "exit 3",
        fixed_ref: "v1.0.0",
        buggy_ref: "v1.0.0-buggy",
      }),
    )
    const file = await configFile("broken.json", { app: "broken", inputs: [] })
    const result = atgRun([file], { ATG_APPS_DIR: apps })
    assert.equal(result.status, 1, result.stdout + result.stderr)
    const [{ run_id }] = JSON.parse(
      execFileSync(process.execPath, [atg, "validate", "--json", file], {
        encoding: "utf8",
        env: { ...process.env, ATG_APPS_DIR: apps },
      }),
    )
    const runDir = join(runs, run_id)
    const metrics = await readJsonFile(join(runDir, "metrics.json"))
    assert.equal(metrics.status, "infra_error")
    assert.match(metrics.error, /^generate: app "broken" did not start: the start command exited with code 3/)
    assert.equal(existsSync(join(runDir, "agent-stdout.txt")), false)
    assert.equal(metrics.fixed, null)
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
      ["code", "code/index.html", "code/server.mjs", "package.json", "playwright.config.ts", "stories.md", "tests"],
    )
    assert.match(await readFile(join(workspace, "code", "index.html"), "utf8"), /input:not\(:checked\)/)
    assert.doesNotMatch(await readFile(join(workspace, "playwright.config.ts"), "utf8"), /localhost/)
    const runDir = runDirOf(file)
    const prompt = await readFile(join(runDir, "prompt.md"), "utf8")
    assert.doesNotMatch(prompt, /localhost|examples/)
    assert.match(prompt, /`stories\.md`[\s\S]*`code\/`/)
    assert.equal(existsSync(join(runDir, "agent-stdout.txt")), false)
    assert.equal(existsSync(join(runDir, "metrics.json")), false)
  })
})
