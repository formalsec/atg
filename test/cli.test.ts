import { Ajv2020 } from "ajv/dist/2020.js"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"
import { coverageTools } from "../src/registries.ts"

const cli = join(import.meta.dirname, "..", "src", "cli.ts")
const dir = await mkdtemp(join(tmpdir(), "atg-"))
after(() => rm(dir, { recursive: true }))

function atg(...args: string[]) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" })
}

async function configFile(name: string, config: unknown) {
  const file = join(dir, name)
  await writeFile(file, JSON.stringify(config))
  return file
}

const valid = {
  schema: 1,
  app: "demo-todo",
  inputs: ["url", "task", "examples", "code"],
  agent: { name: "claude", model: "claude-opus-5-5" },
  framework: "playwright",
  coverage_signal: ["lines"],
}

const keys = { enter: "\r", down: "\x1b[B", space: " ", backspace: "\x7f", ctrlC: "\x03" }

const defaultAnswers = [keys.enter, keys.enter, keys.enter, `m1${keys.enter}`, ...Array(6).fill(keys.enter)]

const prompts = [
  "App under test",
  "Inputs the agent is given",
  "Agent",
  "Model",
  "Max turns",
  "Max budget",
  "Test framework",
  "Coverage signal",
  "Timeout in minutes",
  "Repetition",
]

async function wizard(args: string[], answers: string[], cwd = dir) {
  const child = spawn(process.execPath, [cli, "new", ...args], { cwd })
  let output = ""
  child.stdout.on("data", chunk => (output += chunk))
  child.stderr.on("data", chunk => (output += chunk))
  const exit = new Promise<number | null>(resolve => child.on("exit", resolve))
  let seen = 0
  try {
    for (const [index, answer] of answers.entries()) {
      const at = await waitFor(() => output.indexOf(prompts[index], seen))
      seen = at + prompts[index].length
      child.stdin.write(answer)
    }
  } finally {
    child.stdin.end()
  }
  return { code: await exit, output }
}

async function waitFor(find: () => number) {
  for (let tries = 0; tries < 200; tries++) {
    const at = find()
    if (at >= 0) return at
    await sleep(25)
  }
  throw new Error("prompt never showed up")
}

describe("atg validate", () => {
  test("prints the normalized config and run_id, exit 0", async () => {
    const result = atg("validate", await configFile("valid.json", valid))
    assert.equal(result.status, 0)
    assert.match(result.stdout, /run_id demo-todo__claude__playwright__[0-9a-f]{8}/)
    assert.match(result.stdout, /"timeout_min": 30/)
  })

  test("rejects bad configs with readable errors and a non-zero exit", async () => {
    const files = await Promise.all([
      configFile("unknown-key.json", { ...valid, color: "red" }),
      configFile("duplicate.json", { ...valid, coverage_signal: ["lines", "lines"] }),
      configFile("unimplemented-signal.json", { ...valid, coverage_signal: ["api"] }),
      configFile("unknown-app.json", { ...valid, app: "nope" }),
      configFile("missing-input.json", { ...valid, app: "demo-blog" }),
    ])
    for (const file of files) assert.notEqual(atg("validate", file).status, 0, file)
    const result = atg("validate", ...files)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Unrecognized key: "color"/)
    assert.match(result.stderr, /must not repeat an item\n {2}→ at coverage_signal/)
    assert.match(result.stderr, /coverage tool "api" is not implemented yet, so it cannot be a signal/)
    assert.match(result.stderr, /Invalid option: expected one of "demo-blog"\|"demo-todo"\n {2}→ at app/)
    assert.match(result.stderr, /app "demo-blog" does not provide "code"/)
  })

  test("the pilot config is Claude with all four inputs, every implemented signal tool, Playwright, rep 1 and a budget", () => {
    const result = atg("validate", "--json", join(import.meta.dirname, "..", "configs", "pilot.json"))
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const [{ config }] = JSON.parse(result.stdout)
    assert.equal(config.agent.name, "claude")
    assert.ok(config.agent.max_budget_usd > 0)
    assert.deepEqual(config.inputs, ["code", "examples", "task", "url"])
    assert.deepEqual(config.coverage_signal, coverageTools.filter(tool => tool.implemented).map(tool => tool.name))
    assert.equal(config.framework, "playwright")
    assert.equal(config.rep, 1)
  })

  test("fails when one of several files is invalid, and reports each as JSON", async () => {
    const result = atg("validate", "--json", await configFile("ok.json", valid), join(dir, "missing.json"))
    assert.equal(result.status, 1)
    assert.deepEqual(
      JSON.parse(result.stdout).map((entry: { valid: boolean }) => entry.valid),
      [true, false],
    )
  })
})

describe("atg schema", () => {
  const schema = JSON.parse(atg("schema").stdout)
  const ajv = new Ajv2020()

  test("is valid JSON Schema", () => {
    assert.ok(ajv.validateSchema(schema), ajv.errorsText())
  })

  test("accepts what zod accepts, raw and normalized", async () => {
    const check = ajv.compile(schema)
    const configs = [
      valid,
      { ...valid, inputs: [], coverage_signal: [] },
      { ...valid, agent: { ...valid.agent, max_turns: 40, max_budget_usd: 2.5 }, timeout_min: 10, rep: 3 },
      { ...valid, app: "demo-blog", inputs: ["task"] },
    ]
    for (const config of configs) {
      const result = atg("validate", "--json", await configFile("zod-valid.json", config))
      const [{ config: normalized }] = JSON.parse(result.stdout)
      assert.ok(check(config), ajv.errorsText(check.errors))
      assert.ok(check(normalized), ajv.errorsText(check.errors))
    }
  })

  test("still rejects unknown keys and duplicates", () => {
    const check = ajv.compile(schema)
    assert.equal(check({ ...valid, color: "red" }), false)
    assert.equal(check({ ...valid, inputs: ["url", "url"] }), false)
  })

  test("--out writes the same schema to a file", async () => {
    const out = join(dir, "schema.json")
    atg("schema", "--out", out)
    assert.deepEqual(JSON.parse(await readFile(out, "utf8")), schema)
  })
})

describe("atg apps", () => {
  test("lists each app with the inputs it provides", () => {
    assert.deepEqual(
      JSON.parse(atg("apps", "--json").stdout).map((app: { id: string; inputs: string[] }) => [app.id, app.inputs]),
      [
        ["demo-blog", ["url", "task", "examples"]],
        ["demo-todo", ["url", "task", "examples", "code"]],
      ],
    )
  })
})

describe("atg new", () => {
  test("writes a config with every option chosen", async () => {
    const out = join(dir, "all.json")
    const { code, output } = await wizard(
      ["--out", out],
      [
        keys.down + keys.enter,
        keys.space + keys.down + keys.space + keys.down + keys.space + keys.down + keys.space + keys.enter,
        keys.enter,
        `claude-opus-5-5${keys.enter}`,
        `50${keys.enter}`,
        `2.5${keys.enter}`,
        keys.enter,
        keys.space + keys.enter,
        `45${keys.enter}`,
        `2${keys.enter}`,
      ],
    )
    assert.equal(code, 0, output)
    assert.match(output, /Codex CLI \(not implemented yet\)/)
    assert.match(output, /HTML elements exercised \(not implemented yet\)/)
    assert.deepEqual(JSON.parse(await readFile(out, "utf8")), {
      ...valid,
      inputs: ["code", "examples", "task", "url"],
      agent: { ...valid.agent, max_turns: 50, max_budget_usd: 2.5 },
      coverage_signal: ["lines"],
      timeout_min: 45,
      rep: 2,
    })
    assert.equal(atg("validate", out).status, 0)
  })

  test("accepts the empty input set, leaves caps unset and names the file after the run_id", async () => {
    const cwd = await mkdtemp(join(dir, "cwd-"))
    const { code, output } = await wizard([], defaultAnswers, cwd)
    assert.equal(code, 0, output)
    const [, id] = output.match(/run_id (\S+)/) ?? []
    const config = JSON.parse(await readFile(join(cwd, `${id}.json`), "utf8"))
    assert.deepEqual(config.inputs, [])
    assert.deepEqual(config.coverage_signal, [])
    assert.deepEqual(config.agent, { name: "claude", model: "m1" })
    assert.equal(config.app, "demo-blog")
  })

  const source = {
    ...valid,
    inputs: ["task", "code"],
    agent: { ...valid.agent, max_turns: 30, max_budget_usd: 2.5 },
    coverage_signal: ["lines"],
    timeout_min: 20,
    rep: 3,
  }

  test("--from with Enter on every prompt reproduces the source config and run_id", async () => {
    const from = await configFile("from.json", source)
    const out = join(dir, "from-out.json")
    const { code, output } = await wizard(["--from", from, "--out", out], prompts.map(() => keys.enter))
    assert.equal(code, 0, output)
    const [expected] = JSON.parse(atg("validate", "--json", from).stdout)
    const [written] = JSON.parse(atg("validate", "--json", out).stdout)
    assert.deepEqual(written.config, expected.config)
    assert.equal(written.run_id, expected.run_id)
    assert.match(output, new RegExp(`run_id ${expected.run_id}`))
  })

  test("--from shows defaults that typing replaces", async () => {
    const from = await configFile("from-typed.json", source)
    const out = join(dir, "from-typed-out.json")
    const answers = prompts.map(() => keys.enter)
    answers[3] = `other-model${keys.enter}`
    answers[4] = `80${keys.enter}`
    answers[5] = `10${keys.enter}`
    answers[8] = `45${keys.enter}`
    answers[9] = `4${keys.enter}`
    const { code, output } = await wizard(["--from", from, "--out", out], answers)
    assert.equal(code, 0, output)
    const config = JSON.parse(await readFile(out, "utf8"))
    assert.deepEqual(config.agent, { name: "claude", model: "other-model", max_turns: 80, max_budget_usd: 10 })
    assert.equal(config.timeout_min, 45)
    assert.equal(config.rep, 4)
  })

  test("names the field and the rule when an answer is invalid", async () => {
    const out = join(dir, "invalid-answers.json")
    const answers = [...defaultAnswers]
    answers[3] = `${keys.enter}m1${keys.enter}`
    answers[4] = `abc${keys.enter}${keys.backspace.repeat(3)}${keys.enter}`
    answers[5] = `-1${keys.enter}${keys.backspace.repeat(2)}3${keys.enter}`
    answers[8] = `0${keys.enter}${keys.backspace}45${keys.enter}`
    answers[9] = `x${keys.enter}${keys.backspace}2${keys.enter}`
    const { code, output } = await wizard(["--out", out], answers)
    assert.equal(code, 0, output)
    assert.match(output, /model must not be empty/)
    assert.match(output, /max_turns must be a whole number above 0, or empty for no limit/)
    assert.match(output, /max_budget_usd must be a number above 0, or empty for no limit/)
    assert.match(output, /timeout_min must be a whole number above 0/)
    assert.match(output, /rep must be a whole number above 0/)
    const config = JSON.parse(await readFile(out, "utf8"))
    assert.deepEqual(config.agent, { name: "claude", model: "m1", max_budget_usd: 3 })
    assert.equal(config.timeout_min, 45)
    assert.equal(config.rep, 2)
  })

  for (const [index, prompt] of prompts.entries()) {
    test(`Ctrl+C at "${prompt}" writes nothing`, async () => {
      const out = join(dir, `cancel-${index}.json`)
      const { code, output } = await wizard(["--out", out], [...defaultAnswers.slice(0, index), keys.ctrlC])
      assert.equal(code, 130, output)
      assert.match(output, /Cancelled, nothing was written/)
      assert.equal(existsSync(out), false)
    })
  }
})

describe("help", () => {
  test("lists every command and flag", () => {
    assert.match(atg("--help").stdout, /validate[\s\S]*schema[\s\S]*apps[\s\S]*new[\s\S]*run[\s\S]*doctor/)
    const flags = {
      validate: ["--json"],
      schema: ["--out <file>"],
      apps: ["--json"],
      new: ["--out <file>", "--from <config>"],
      run: ["--dry-run", "--force", "--runs-dir <dir>", "--keep-workspace"],
      doctor: [],
    }
    for (const [command, expected] of Object.entries(flags)) {
      const help = atg(command, "--help").stdout
      for (const flag of expected) assert.ok(help.includes(flag), `${command} --help lacks ${flag}`)
    }
  })
})
