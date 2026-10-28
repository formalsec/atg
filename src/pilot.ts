import { join, resolve } from "node:path"
import * as z from "zod"
import { evaluationStages } from "./evaluate.ts"
import { duration, readJson, readRun, runFiles } from "./run-folder.ts"

const grid = { runs: 11_520, agents: 3 }
const rerunChoices = [1, 3, 5]

const metricsSchema = z.object({
  status: z.string(),
  stop_reason: z.string().nullable(),
  tokens: z.object({ input: z.number(), output: z.number(), cache_read: z.number(), cache_creation: z.number() }).nullable(),
  cost_usd: z.number().nullable(),
  cost_source: z.string().nullable(),
  turns: z.number().nullable(),
  wall_ms: z.record(z.string(), z.number()),
  repetition_ms: z.object({
    fixed: z.array(z.number()).nullable(),
    buggy: z.array(z.number()).nullable(),
    bugs: z.record(z.string(), z.array(z.number())).nullable(),
  }),
  evaluation: z.object({ protocol: z.number(), reruns: z.number().nullable() }),
  n_tests: z.number().nullable(),
  fixed: z.object({ stable_pass: z.number(), broken: z.number(), flaky: z.number(), skipped: z.number() }).nullable(),
  buggy: z.object({ revealing: z.number(), flaky_on_buggy: z.number(), not_revealing: z.number() }).nullable(),
  caught: z.boolean().nullable(),
  caught_strict: z.boolean().nullable(),
  not_caught_reason: z.string().nullable(),
  bugs: z
    .object({
      tested: z.number(),
      detected: z.number(),
      detection_rate: z.number(),
      by_bug: z.record(z.string(), z.object({ revealing: z.number() })),
    })
    .nullable(),
  coverage: z.record(z.string(), z.object({ covered: z.number(), total: z.number(), pct: z.number() }).nullable()),
  signal_calls: z.number(),
})

export async function pilot(runId: string, options: { runsDir: string; concurrency: number }) {
  const runDir = resolve(options.runsDir, runId)
  const { config } = await readRun(runDir)
  const metrics = metricsSchema.parse(await readJson(join(runDir, runFiles.metrics)))
  const { tokens, fixed, buggy, bugs, evaluation } = metrics
  const totalMs = sum(Object.values(metrics.wall_ms))
  const evaluationMs = sum(Object.keys(evaluationStages).map(name => metrics.wall_ms[name] ?? 0))
  const means = repetitionMeans(metrics.repetition_ms)
  const repetitionMs = sum(means.map(({ ms }) => ms))
  const outsideMs = evaluationMs - (evaluation.reruns ?? 0) * repetitionMs
  const evaluationHours = rerunChoices.map(reruns => `R=${reruns} ${hours((outsideMs + reruns * repetitionMs) * grid.runs)}`)
  const generateMs = metrics.wall_ms.generate ?? 0
  const runsPerAgent = grid.runs / grid.agents
  const cost = metrics.cost_usd === null ? "unknown" : `${usd(metrics.cost_usd)} (${metrics.cost_source})`
  const stages = Object.entries(metrics.wall_ms).map(([name, ms]) => `${name} ${duration(ms)}`)
  const evaluationTimes = Object.keys(evaluationStages).flatMap(name =>
    metrics.wall_ms[name] === undefined ? [] : [`${name} ${duration(metrics.wall_ms[name])}`],
  )
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
      `| Coverage | ${coverage.join(", ")} |`,
      `| Signal calls | ${metrics.signal_calls} |`,
      "",
      "## Bug finding",
      "",
      "| Measure | Value |",
      "| --- | --- |",
      `| Repetitions | ${evaluation.reruns ?? "none"} per version, evaluation protocol ${evaluation.protocol} |`,
      `| Tests on fixed | ${fixed ? `${metrics.n_tests} tests: ${fixed.stable_pass} stable_pass, ${fixed.broken} broken, ${fixed.flaky} flaky, ${fixed.skipped} skipped` : "not evaluated"} |`,
      `| Tests on buggy | ${buggy ? `${buggy.revealing} revealing, ${buggy.flaky_on_buggy} flaky_on_buggy, ${buggy.not_revealing} not_revealing` : "not evaluated"} |`,
      `| Caught | ${metrics.caught === null ? "not evaluated" : `caught ${metrics.caught}, caught_strict ${metrics.caught_strict}${metrics.not_caught_reason ? ` (${metrics.not_caught_reason})` : ""}`} |`,
      `| Per-bug detection | ${bugs ? `${bugs.detected} of ${bugs.tested} bugs (${percent(bugs.detection_rate)}): ${Object.entries(bugs.by_bug).map(([id, block]) => `${id} ${block.revealing} revealing`).join(", ")}` : "no bug list"} |`,
      `| Evaluation time | ${evaluationTimes.join(", ")}; total ${duration(evaluationMs)} |`,
      `| One repetition | ${means.map(({ name, ms }) => `${name} ${duration(ms)}`).join(", ") || "none"} (mean of each version) |`,
      "",
      `## Full grid of ${count(grid.runs)} runs`,
      "",
      "| Estimate | Value | Assumption |",
      "| --- | --- | --- |",
      `| Total cost | ${metrics.cost_usd === null ? "unknown" : usd(metrics.cost_usd * grid.runs)} | Every run costs what this run cost: ${cost}. |`,
      `| Agent-hours | ${hours(generateMs * grid.runs)} | Every agent stage takes what this run's generate stage took: ${duration(generateMs)}. |`,
      `| Evaluation-hours | ${evaluationHours.join(", ")} | Every evaluation takes this run's evaluation time outside the repetitions, ${duration(outsideMs)}, plus R times one repetition of every version, ${duration(repetitionMs)}. |`,
      `| Calendar time | ${duration((runsPerAgent * totalMs) / options.concurrency)} | The ${grid.agents} agents run side by side, each does ${count(runsPerAgent)} runs with ${options.concurrency} at a time, and every run takes this run's total wall time: ${duration(totalMs)}. Runs whose apps share a url wait for each other, so the runs at the same time must use apps with different urls. |`,
    ].join("\n"),
  )
}

function repetitionMeans({ fixed, buggy, bugs }: z.infer<typeof metricsSchema>["repetition_ms"]) {
  const perBug = Object.entries(bugs ?? {}).map(([id, runs]) => [`bugs/${id}`, runs])
  const versions: Record<string, number[]> = { fixed: fixed ?? [], buggy: buggy ?? [], ...Object.fromEntries(perBug) }
  return Object.entries(versions)
    .filter(([, runs]) => runs.length > 0)
    .map(([name, runs]) => ({ name, ms: sum(runs) / runs.length }))
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

function hours(ms: number) {
  return `${(ms / 3_600_000).toFixed(1)} h`
}

function percent(rate: number) {
  return `${Math.round(rate * 100)}%`
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
