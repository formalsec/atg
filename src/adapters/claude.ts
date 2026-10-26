import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import * as z from "zod"
import { check } from "../check.ts"
import type { AgentAdapter, AgentOutput, AgentResult, Invocation } from "../registries.ts"

const exec = promisify(execFile)

const finishingStops = ["success", "error_max_turns", "error_max_budget_usd"]

const usageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadInputTokens: z.number(),
  cacheCreationInputTokens: z.number(),
  costUSD: z.number(),
  costBasis: z.string().default("unknown"),
})

type Usage = z.infer<typeof usageSchema>

const resultSchema = z.object({
  type: z.literal("result"),
  subtype: z.string(),
  is_error: z.boolean(),
  result: z.string().optional(),
  num_turns: z.number().optional(),
  duration_ms: z.number().optional(),
  duration_api_ms: z.number().optional(),
  modelUsage: z.record(z.string(), usageSchema).default({}),
})

export const claude: AgentAdapter = {
  invocation({ agent, commands }) {
    const { isolation, args, env } = isolate()
    return {
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "json",
        "--model",
        agent.model,
        ...(agent.max_turns === undefined ? [] : ["--max-turns", String(agent.max_turns)]),
        ...(agent.max_budget_usd === undefined ? [] : ["--max-budget-usd", String(agent.max_budget_usd)]),
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        "Read(./**)",
        "Edit(./**)",
        "Write(./**)",
        ...commands.flatMap(command => [`Bash(${command})`, `Bash(${command} *)`]),
        "--no-session-persistence",
        "--strict-mcp-config",
        ...args,
      ],
      env,
      isolation,
    }
  },
  parse,
  version,
  async checks() {
    return [await check("Claude CLI", version), await check("Claude isolation", isolationAvailable)]
  },
}

function isolate(): Pick<Invocation, "isolation" | "args" | "env"> {
  const key = process.env.ANTHROPIC_API_KEY
  if (key) return { isolation: "bare", args: ["--bare"], env: { ANTHROPIC_API_KEY: key } }
  const settings = { claudeMdExcludes: [join(homedir(), ".claude", "**")], autoMemoryEnabled: false }
  return { isolation: "settings", args: ["--setting-sources", "", "--settings", JSON.stringify(settings)], env: {} }
}

function parse({ stdout, stderr, code, error }: AgentOutput): AgentResult {
  const parsed = resultSchema.safeParse(jsonOrNothing(stdout))
  if (!parsed.success) {
    const why = [`exit ${code}`, error, (stderr || stdout).trim().slice(-2000)].filter(Boolean).join(": ")
    return { status: "agent_error", error: `no parseable result (${why})` }
  }
  const result = parsed.data
  const usage = Object.values(result.modelUsage)
  const sum = (key: Exclude<keyof Usage, "costBasis">) => usage.reduce((total, model) => total + model[key], 0)
  const finished = finishingStops.includes(result.subtype) && !(result.subtype === "success" && result.is_error)
  return {
    status: finished ? "ok" : "agent_error",
    stop_reason: result.subtype,
    error: finished ? undefined : (result.result ?? result.subtype),
    turns: result.num_turns,
    duration_ms: result.duration_ms,
    api_duration_ms: result.duration_api_ms,
    tokens: {
      input: sum("inputTokens"),
      output: sum("outputTokens"),
      cache_read: sum("cacheReadInputTokens"),
      cache_creation: sum("cacheCreationInputTokens"),
    },
    cost_usd: sum("costUSD"),
    cost_source: `estimate:${[...new Set(usage.map(model => model.costBasis))].join("+") || "none"}`,
    models: Object.keys(result.modelUsage),
  }
}

async function version() {
  const { stdout } = await exec("claude", ["--version"])
  return stdout.trim()
}

async function isolationAvailable() {
  if (process.env.ANTHROPIC_API_KEY) return "bare mode, ANTHROPIC_API_KEY is set"
  const { stdout } = await exec("claude", ["auth", "status", "--json"]).catch(() => ({ stdout: "" }))
  const status = z.object({ loggedIn: z.literal(true), authMethod: z.string() }).safeParse(jsonOrNothing(stdout))
  if (!status.success) throw new Error("no ANTHROPIC_API_KEY and no subscription login (run: claude auth login)")
  return `settings mode, subscription login (${status.data.authMethod})`
}

function jsonOrNothing(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
