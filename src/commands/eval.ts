import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import { runFiles, runStage, stopOnSignals } from "../run-folder.ts"
import { coverage } from "../stages/coverage.ts"
import { evaluate } from "../stages/evaluate.ts"
import { finalize, type Metrics } from "../stages/finalize.ts"

export const evaluationStages: Record<string, (runDir: string) => Promise<void>> = { evaluate, coverage }

export async function evaluateRun(runId: string, options: { only?: string; runsDir: string }) {
  const runDir = resolve(options.runsDir, runId)
  if (!existsSync(join(runDir, runFiles.metrics))) throw new Error(`run ${runId} is not finished: ${runDir} has no metrics.json`)
  stopOnSignals(runDir, true)
  await runEvaluation(runDir, options.only ? [options.only] : Object.keys(evaluationStages))
  const metrics = await finalize(runDir)
  printMetrics(runId, runDir, metrics)
  if (metrics.status === "infra_error") process.exitCode = 1
}

export async function runEvaluation(runDir: string, names: string[]) {
  for (const name of names) {
    if (await runStage(runDir, name, () => evaluationStages[name](runDir))) return
  }
}

export function printMetrics(id: string, runDir: string, metrics: Metrics) {
  const fixed = metrics.fixed
  const coverage = Object.entries(metrics.coverage).map(([name, block]) => `${name} ${block ? `${block.pct}%` : "not measured"}`)
  console.log(
    [
      `run_id ${id}`,
      `status ${metrics.status}${metrics.stop_reason ? ` (${metrics.stop_reason})` : ""}`,
      ...(metrics.error ? [`error ${metrics.error}`] : []),
      fixed
        ? `fixed: ${metrics.n_tests} tests, ${fixed.passed} passed, ${fixed.failed} failed, ${fixed.flaky} flaky`
        : "fixed: not evaluated",
      `coverage: ${coverage.join(", ")}`,
      `cost ${metrics.cost_usd ?? "unknown"} USD (${metrics.cost_source ?? "no result"}), ${metrics.turns ?? "?"} turns`,
      runDir,
    ].join("\n"),
  )
}
