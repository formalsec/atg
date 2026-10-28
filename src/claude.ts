import { execFile } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import * as z from "zod"
import type { Config } from "./config.ts"

const exec = promisify(execFile)

const finishingStops = ["success", "error_max_turns", "error_max_budget_usd"]

export const agentResultSchema = z.object({
  status: z.enum(["ok", "agent_error", "timeout"]),
  stop_reason: z.string().optional(),
  error: z.string().optional(),
  turns: z.number().optional(),
  duration_ms: z.number().optional(),
  api_duration_ms: z.number().optional(),
  tokens: z
    .object({ input: z.number(), output: z.number(), cache_read: z.number(), cache_creation: z.number() })
    .optional(),
  cost_usd: z.number().optional(),
  cost_source: z.string().optional(),
  models: z.array(z.string()).optional(),
})

export type AgentResult = z.infer<typeof agentResultSchema>

export type Invocation = { command: string; args: string[]; env: Record<string, string>; isolation: string }

type Output = { stdout: string; stderr: string; code: number | null; error?: string }

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

const assistantSchema = z.object({
  type: z.literal("assistant"),
  message: z.object({ content: z.array(z.unknown()) }),
})

const toolCallSchema = z.object({
  type: z.literal("tool_use"),
  name: z.string(),
  input: z.object({ file_path: z.string(), command: z.string(), pattern: z.string() }).partial(),
})

export function invocation(agent: Config["agent"], commands: string[]): Invocation {
  const { isolation, args, env } = isolate()
  return {
    command: "claude",
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
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
}

function isolate(): Pick<Invocation, "isolation" | "args" | "env"> {
  const key = process.env.ANTHROPIC_API_KEY
  if (key) return { isolation: "bare", args: ["--bare"], env: { ANTHROPIC_API_KEY: key } }
  const settings = { claudeMdExcludes: [join(homedir(), ".claude", "**")], autoMemoryEnabled: false }
  return { isolation: "settings", args: ["--setting-sources", "", "--settings", JSON.stringify(settings)], env: {} }
}

export function parse({ stdout, stderr, code, error }: Output): AgentResult {
  const lastLine = stdout.trim().split("\n").at(-1) ?? ""
  const parsed = resultSchema.safeParse(jsonOrNothing(lastLine))
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

export function activity(line: string) {
  const event = assistantSchema.safeParse(jsonOrNothing(line))
  if (!event.success) return undefined
  const calls = event.data.message.content.flatMap(block => {
    const call = toolCallSchema.safeParse(block)
    return call.success ? [describeCall(call.data)] : []
  })
  return calls.length > 0 ? calls.join("\n") : undefined
}

function describeCall({ name, input }: z.infer<typeof toolCallSchema>) {
  const target = input.file_path ?? input.command?.split("\n")[0] ?? input.pattern
  return target === undefined ? name : `${name} ${target}`
}

export async function version() {
  const { stdout } = await exec("claude", ["--version"])
  return stdout.trim()
}

function jsonOrNothing(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
