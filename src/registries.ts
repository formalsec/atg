import * as z from "zod"
import { claude } from "./adapters/claude.ts"
import { playwright } from "./adapters/playwright.ts"
import type { Check } from "./check.ts"
import type { Config } from "./config.ts"

export type Descriptor = {
  name: string
  label: string
  implemented: boolean
}

export type AgentInput = {
  workspace: string
  prompt: string
  agent: Config["agent"]
  timeLimitMs: number
  commands: string[]
}

export type Invocation = { command: string; args: string[]; env: Record<string, string>; isolation: string }

export type AgentOutput = { stdout: string; stderr: string; code: number | null; error?: string }

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

export type AgentAdapter = {
  invocation(input: AgentInput): Invocation
  parse(output: AgentOutput): AgentResult
  version(): Promise<string>
  checks(): Promise<Check[]>
}

export const suiteResultSchema = z.object({
  tests: z.array(
    z.object({
      title: z.string(),
      file: z.string(),
      status: z.enum(["passed", "failed", "flaky", "skipped"]),
      duration_ms: z.number(),
      error: z.string().optional(),
    }),
  ),
  errors: z.array(z.string()),
})

export type SuiteResult = z.infer<typeof suiteResultSchema>

export type SuiteRun = { testsDir: string; baseUrl: string; reportFile: string; logFile: string; timeoutMs: number }

export type FrameworkAdapter = {
  testDir: string
  testCommand: string
  scaffold(dir: string, baseUrl?: string): Promise<void>
  run(suite: SuiteRun): Promise<SuiteResult & { versions: Record<string, string> }>
  checks(): Promise<Check[]>
}

export const agents: (Descriptor & { adapter?: AgentAdapter })[] = [
  { name: "claude", label: "Claude Code", implemented: true, adapter: claude },
  { name: "codex", label: "Codex CLI", implemented: false },
  { name: "gemini", label: "Gemini CLI", implemented: false },
]

export const frameworks: (Descriptor & { adapter?: FrameworkAdapter })[] = [
  { name: "playwright", label: "Playwright", implemented: true, adapter: playwright },
  { name: "selenium", label: "Selenium", implemented: false },
  { name: "cypress", label: "Cypress", implemented: false },
]

export const coverageTools: Descriptor[] = [
  { name: "lines", label: "Lines of app code executed", implemented: true },
  { name: "html", label: "HTML elements exercised", implemented: true },
  { name: "api", label: "API endpoints called", implemented: true },
]

export function agentEntry(name: string) {
  return withAdapter(agents, name)
}

export function frameworkEntry(name: string) {
  return withAdapter(frameworks, name)
}

function withAdapter<T>(registry: (Descriptor & { adapter?: T })[], name: string) {
  const entry = registry.find(entry => entry.name === name)
  if (!entry?.adapter) throw new Error(`"${name}" is not implemented yet`)
  return { ...entry, adapter: entry.adapter }
}
