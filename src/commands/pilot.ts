import { join, resolve } from "node:path"
import * as z from "zod"
import { readJson } from "../json.ts"
import { readRun, runFiles } from "../run-folder.ts"

const grid = { runs: 11_520, agents: 3 }

const metricsSchema = z.object({
  status: z.string(),
  stop_reason: z.string().nullable(),
  tokens: z.object({ input: z.number(), output: z.number(), cache_read: z.number(), cache_creation: z.number() }).nullable(),
  cost_usd: z.number().nullable(),
  cost_source: z.string().nullable(),
  turns: z.number().nullable(),
  wall_ms: z.record(z.string(), z.number()),
  n_tests: z.number().nullable(),
  fixed: z.object({ passed: z.number(), failed: z.number(), flaky: z.number(), skipped: z.number() }).nullable(),
  coverage: z.record(z.string(), z.object({ covered: z.number(), total: z.number(), pct: z.number() }).nullable()),
  signal_calls: z.number(),
})

export async function pilot(runId: string, options: { runsDir: string; concurrency: number }) {
  const runDir = resolve(options.runsDir, runId)
  const { config } = await readRun(runDir)
  const metrics = metricsSchema.parse(await readJson(join(runDir, runFiles.metrics)))
  const { tokens, fixed } = metrics
  const totalMs = Object.values(metrics.wall_ms).reduce((total, ms) => total + ms, 0)
  const generateMs = metrics.wall_ms.generate ?? 0
  const runsPerAgent = grid.runs / grid.agents
  const cost = metrics.cost_usd === null ? "unknown" : `${usd(metrics.cost_usd)} (${metrics.cost_source})`
  const stages = Object.entries(metrics.wall_ms).map(([name, ms]) => `${name} ${duration(ms)}`)
  const coverage = Object.entries(metrics.coverage).map(([name, block]) =>
    block ? `${name} ${block.pct}% (${block.covered} of ${block.total})` : `${name} not measured`,
  )
  const agent = config.agent
  console.log(
    [
      `# Cost pilot`,
      "",
      `Run \`${runId}\`: ${agent.name} ${agent.model}, inputs ${list(config.inputs)}, coverage_signal ${list(config.coverage_signal)}, ${config.framework}, rep ${config.rep}, max_budget_usd ${agent.max_budget_usd ?? "none"}. Status ${metrics.status}${metrics.stop_reason ? ` (${metrics.stop_reason})` : ""}.`,
      "",
      "## This run",
      "",
      "| Measure | Value |",
      "| --- | --- |",
      `| Wall time | ${stages.join(", ")}; total ${duration(totalMs)} |`,
      `| Tokens | ${tokens ? `input ${count(tokens.input)}, output ${count(tokens.output)}, cache read ${count(tokens.cache_read)}, cache creation ${count(tokens.cache_creation)}` : "unknown"} |`,
      `| Cost | ${cost} |`,
      `| Turns | ${metrics.turns ?? "unknown"} |`,
      `| Tests on fixed | ${fixed ? `${metrics.n_tests} tests: ${fixed.passed} passed, ${fixed.failed} failed, ${fixed.flaky} flaky, ${fixed.skipped} skipped` : "not evaluated"} |`,
      `| Coverage | ${coverage.join(", ")} |`,
      `| Signal calls | ${metrics.signal_calls} |`,
      "",
      `## Full grid of ${count(grid.runs)} runs`,
      "",
      "| Estimate | Value | Assumption |",
      "| --- | --- | --- |",
      `| Total cost | ${metrics.cost_usd === null ? "unknown" : usd(metrics.cost_usd * grid.runs)} | Every run costs what this run cost: ${cost}. |`,
      `| Agent-hours | ${((generateMs * grid.runs) / 3_600_000).toFixed(1)} h | Every agent stage takes what this run's generate stage took: ${duration(generateMs)}. |`,
      `| Calendar time | ${duration((runsPerAgent * totalMs) / options.concurrency)} | The ${grid.agents} agents run side by side, each does ${count(runsPerAgent)} runs with ${options.concurrency} at a time, and every run takes this run's total wall time: ${duration(totalMs)}. |`,
    ].join("\n"),
  )
}

function list(items: string[]) {
  return items.length > 0 ? items.join(", ") : "none"
}

function count(value: number) {
  return value.toLocaleString("en-US")
}

function usd(value: number) {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function duration(ms: number) {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`
  if (seconds < 48 * 3600) return `${(seconds / 3600).toFixed(1)} h`
  return `${(seconds / 86_400).toFixed(1)} days`
}
