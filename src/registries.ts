import * as z from "zod"
import { claude } from "./adapters/claude.ts"
import { monocart } from "./adapters/monocart.ts"
import { playwright } from "./adapters/playwright.ts"
import type { App } from "./apps.ts"
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
      key: z.string(),
      status: z.enum(["passed", "failed", "flaky", "skipped"]),
      duration_ms: z.number(),
      error: z.string().optional(),
    }),
  ),
  errors: z.array(z.string()),
})

export type SuiteResult = z.infer<typeof suiteResultSchema>

export type Collector = { module: string; dir: string }

export type SuiteRun = {
  testsDir: string
  baseUrl: string
  reportFile: string
  logFile: string
  timeoutMs: number
  collectors: Collector[]
}

export type FrameworkAdapter = {
  testDir: string
  testCommand: string
  scaffold(dir: string, baseUrl?: string): Promise<void>
  run(suite: SuiteRun): Promise<SuiteResult & { versions: Record<string, string> }>
  checks(): Promise<Check[]>
}

export const coverageSchema = z.object({
  covered: z.number(),
  total: z.number(),
  pct: z.number(),
  report: z.string(),
  uncovered: z.array(z.string()),
})

export type Coverage = z.infer<typeof coverageSchema>

export type CoverageRun = { app: App; source: string; baseUrl: string; dir: string }

export type CoverageAdapter = {
  collector?: string
  universe?(run: CoverageRun): Promise<void>
  report(run: CoverageRun): Promise<Coverage | null>
}

const notMeasured: CoverageAdapter = { report: async () => null }

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

export const coverageTools: (Descriptor & { adapter: CoverageAdapter })[] = [
  { name: "lines", label: "Browser-side line coverage", implemented: true, adapter: monocart },
  { name: "html", label: "HTML elements exercised", implemented: false, adapter: notMeasured },
  { name: "api", label: "API endpoints called", implemented: false, adapter: notMeasured },
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
