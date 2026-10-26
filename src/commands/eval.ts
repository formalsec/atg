import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { runFiles, runStage, stopOnSignals } from "../run-folder.ts"
import { coverage } from "../stages/coverage.ts"
import { bugs, buggy, fixed } from "../stages/evaluate.ts"
import { finalize, type Metrics } from "../stages/finalize.ts"

export const evaluationStages: Record<string, (runDir: string, reruns: number) => Promise<void>> = {
  fixed,
  buggy,
  bugs,
  coverage,
}

type Options = { only?: string; reruns: number; runsDir: string }

export async function evaluateRun(runId: string, options: Options) {
  const runDir = resolve(options.runsDir, runId)
  if (!existsSync(join(runDir, runFiles.metrics))) throw new Error(`run ${runId} is not finished: ${runDir} has no metrics.json`)
  stopOnSignals(runDir, true)
  await runEvaluation(runDir, options.only ? [options.only] : Object.keys(evaluationStages), options.reruns)
  const metrics = await finalize(runDir)
  printMetrics(runId, runDir, metrics)
  if (metrics.status === "infra_error") process.exitCode = 1
}

export async function runEvaluation(runDir: string, names: string[], reruns: number) {
  for (const name of names) {
    if (await runStage(runDir, name, () => evaluationStages[name](runDir, reruns))) return
  }
}

export function printMetrics(id: string, runDir: string, metrics: Metrics) {
  const { fixed, buggy, bugs } = metrics
  const coverage = Object.entries(metrics.coverage).map(([name, block]) => `${name} ${block ? `${block.pct}%` : "not measured"}`)
  console.log(
    [
      `run_id ${id}`,
      `status ${metrics.status}${metrics.stop_reason ? ` (${metrics.stop_reason})` : ""}`,
      ...(metrics.error ? [`error ${metrics.error}`] : []),
      fixed
        ? `fixed: ${metrics.n_tests} tests, ${metrics.evaluation.reruns} repetitions, ${fixed.stable_pass} stable_pass, ${fixed.broken} broken, ${fixed.flaky} flaky, ${fixed.skipped} skipped`
        : "fixed: not evaluated",
      buggy
        ? `buggy: ${buggy.revealing} revealing, ${buggy.flaky_on_buggy} flaky_on_buggy, ${buggy.not_revealing} not_revealing, caught ${metrics.caught}, caught_strict ${metrics.caught_strict}`
        : "buggy: not evaluated",
      ...(bugs ? [`bugs: ${bugs.detected} of ${bugs.tested} detected`] : []),
      `coverage: ${coverage.join(", ")}`,
      `cost ${metrics.cost_usd ?? "unknown"} USD (${metrics.cost_source ?? "no result"}), ${metrics.turns ?? "?"} turns`,
      runDir,
    ].join("\n"),
  )
}
