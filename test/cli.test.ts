import { Ajv2020 } from "ajv/dist/2020.js"
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { setTimeout as sleep } from "node:timers/promises"

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
  coverage_signal: ["lines", "html", "api"],
}

const keys = { enter: "\r", down: "\x1b[B", space: " ", backspace: "\x7f", ctrlC: "\x03" }

const defaultAnswers = [keys.enter, keys.enter, keys.enter, `m1${keys.enter}`, keys.enter, keys.enter, keys.enter, keys.enter]

const prompts = [
  "App under test",
  "Inputs the agent is given",
  "Agent",
  "Model",
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
      configFile("duplicate.json", { ...valid, coverage_signal: ["api", "api"] }),
      configFile("unknown-app.json", { ...valid, app: "nope" }),
      configFile("missing-input.json", { ...valid, app: "demo-blog" }),
    ])
    for (const file of files) assert.notEqual(atg("validate", file).status, 0, file)
    const result = atg("validate", ...files)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Unrecognized key: "color"/)
    assert.match(result.stderr, /must not repeat an item\n {2}→ at coverage_signal/)
    assert.match(result.stderr, /Invalid option: expected one of "demo-blog"\|"demo-todo"\n {2}→ at app/)
    assert.match(result.stderr, /app "demo-blog" does not provide "code"/)
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
        keys.enter,
        keys.space + keys.down + keys.space + keys.down + keys.space + keys.enter,
        `${keys.backspace.repeat(2)}45${keys.enter}`,
        `${keys.backspace}2${keys.enter}`,
      ],
    )
    assert.equal(code, 0, output)
    assert.match(output, /Codex CLI \(not implemented yet\)/)
    const config = JSON.parse(await readFile(out, "utf8"))
    assert.deepEqual(config, {
      ...valid,
      inputs: ["code", "examples", "task", "url"],
      coverage_signal: ["api", "html", "lines"],
      timeout_min: 45,
      rep: 2,
    })
    assert.equal(atg("validate", out).status, 0)
  })

  test("accepts the empty input set and names the file after the run_id", async () => {
    const cwd = await mkdtemp(join(dir, "cwd-"))
    const { code, output } = await wizard([], defaultAnswers, cwd)
    assert.equal(code, 0, output)
    const [, id] = output.match(/run_id (\S+)/) ?? []
    const config = JSON.parse(await readFile(join(cwd, `${id}.json`), "utf8"))
    assert.deepEqual(config.inputs, [])
    assert.deepEqual(config.coverage_signal, [])
    assert.equal(config.app, "demo-blog")
  })

  test("--from prefills every answer and keeps agent limits", async () => {
    const from = await configFile("from.json", {
      ...valid,
      inputs: ["task", "code"],
      agent: { ...valid.agent, max_turns: 30 },
      coverage_signal: ["html"],
      timeout_min: 20,
      rep: 3,
    })
    const out = join(dir, "from-out.json")
    const { code, output } = await wizard(["--from", from, "--out", out], prompts.map(() => keys.enter))
    assert.equal(code, 0, output)
    const expected = JSON.parse(atg("validate", "--json", from).stdout)[0].config
    assert.deepEqual(JSON.parse(await readFile(out, "utf8")), expected)
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
