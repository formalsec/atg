import assert from "node:assert/strict"
import { describe, test } from "node:test"
import * as claude from "../src/claude.ts"
import type { Config } from "../src/config.ts"
import { commandLine } from "../src/run.ts"

const agent: Config["agent"] = { name: "claude", model: "m1", max_turns: 5, max_budget_usd: 2 }
const commands = ["npx playwright test"]

const usage = (tokens: number, costUSD: number) => ({
  inputTokens: tokens,
  outputTokens: tokens * 2,
  cacheReadInputTokens: tokens * 3,
  cacheCreationInputTokens: tokens * 4,
  costUSD,
  costBasis: "list",
})

const result = (fields: object) =>
  JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 4,
    duration_ms: 900,
    duration_api_ms: 700,
    result: "done",
    modelUsage: { "claude-opus-5-5": usage(10, 0.5), "claude-haiku-5-5": usage(1, 0.25) },
    ...fields,
  })

const parse = (stdout: string) => claude.parse({ stdout, stderr: "", code: 0 })

function withApiKey<T>(value: string | undefined, run: () => T) {
  const saved = process.env.ANTHROPIC_API_KEY
  if (value === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = value
  try {
    return run()
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = saved
  }
}

describe("claude adapter invocation", () => {
  test("runs headless with limits, dontAsk and an explicit tool list", () => {
    const { command, args } = withApiKey(undefined, () => claude.invocation(agent, commands))
    assert.equal(command, "claude")
    const line = args.join(" ")
    for (const part of [
      "-p --output-format stream-json --verbose --model m1 --max-turns 5 --max-budget-usd 2",
      "--permission-mode dontAsk",
      "--allowedTools Read(./**) Edit(./**) Write(./**) Bash(npx playwright test) Bash(npx playwright test *)",
      "--no-session-persistence --strict-mcp-config",
    ]) {
      assert.ok(line.includes(part), `missing "${part}" in ${line}`)
    }
  })

  test("without an API key, skips setting sources and excludes user memory", () => {
    const { args, env, isolation } = withApiKey(undefined, () => claude.invocation(agent, commands))
    assert.equal(isolation, "settings")
    assert.deepEqual(env, {})
    assert.equal(args.includes("--bare"), false)
    assert.equal(args[args.indexOf("--setting-sources") + 1], "")
    const settings = JSON.parse(args[args.indexOf("--settings") + 1])
    assert.equal(settings.autoMemoryEnabled, false)
    assert.match(settings.claudeMdExcludes[0], /\/\.claude\/\*\*$/)
  })

  test("with an API key, runs bare and passes only that key", () => {
    const { args, env, isolation } = withApiKey("sk-test", () => claude.invocation(agent, commands))
    assert.equal(isolation, "bare")
    assert.deepEqual(env, { ANTHROPIC_API_KEY: "sk-test" })
    assert.ok(args.includes("--bare"))
    assert.equal(args.includes("--setting-sources"), false)
  })

  test("with an API key, the saved command names the key and never shows its value", () => {
    const invocation = withApiKey("sk-test-secret", () => claude.invocation(agent, commands))
    const line = commandLine({ ...invocation, cwd: "/w" }, "/run/prompt.md")
    assert.ok(line.includes(`ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY"`), line)
    assert.equal(line.includes("sk-test-secret"), false, line)
  })

  test("leaves out limits that are not set", () => {
    const { args } = claude.invocation({ name: "claude", model: "m1" }, commands)
    assert.equal(args.includes("--max-turns"), false)
    assert.equal(args.includes("--max-budget-usd"), false)
  })
})

describe("claude adapter result", () => {
  test("sums tokens and cost over every model and keeps the model ids", () => {
    assert.deepEqual(parse(result({})), {
      status: "ok",
      stop_reason: "success",
      error: undefined,
      turns: 4,
      duration_ms: 900,
      api_duration_ms: 700,
      tokens: { input: 11, output: 22, cache_read: 33, cache_creation: 44 },
      cost_usd: 0.75,
      cost_source: "estimate:list",
      models: ["claude-opus-5-5", "claude-haiku-5-5"],
    })
  })

  test("reads the result from the last line of the event stream", () => {
    const stream = `${JSON.stringify({ type: "system", subtype: "init" })}\n${result({})}\n`
    assert.equal(parse(stream).status, "ok")
  })

  test("a turn or budget limit is a finished run with its stop reason", () => {
    for (const subtype of ["error_max_turns", "error_max_budget_usd"]) {
      const parsed = parse(result({ subtype, is_error: true }))
      assert.equal(parsed.status, "ok")
      assert.equal(parsed.stop_reason, subtype)
    }
  })

  test("an execution error, an auth failure or no JSON is an agent error", () => {
    assert.equal(parse(result({ subtype: "error_during_execution", is_error: true })).status, "agent_error")
    const auth = parse(result({ is_error: true, result: "Invalid API key", modelUsage: {} }))
    assert.equal(auth.status, "agent_error")
    assert.equal(auth.error, "Invalid API key")
    const garbage = claude.parse({ stdout: "not json", stderr: "boom", code: 1 })
    assert.equal(garbage.status, "agent_error")
    assert.match(garbage.error ?? "", /^no parseable result \(exit 1: boom\)$/)
  })
})

describe("claude adapter activity", () => {
  test("names each tool call with its file, command or pattern", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading first" },
          { type: "tool_use", name: "Read", input: { file_path: "/w/src/app.ts" } },
          { type: "tool_use", name: "Bash", input: { command: "npx playwright test\n--reporter list", description: "Run" } },
          { type: "tool_use", name: "Grep", input: { pattern: "todo" } },
          { type: "tool_use", name: "TodoWrite", input: { todos: [] } },
        ],
      },
    })
    assert.equal(claude.activity(line), "Read /w/src/app.ts\nBash npx playwright test\nGrep todo\nTodoWrite")
  })

  test("ignores lines without a tool call", () => {
    const text = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })
    for (const line of [result({}), text, "not json", ""]) assert.equal(claude.activity(line), undefined)
  })
})
