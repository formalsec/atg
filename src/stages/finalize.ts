import { existsSync } from "node:fs"
import { readFile, rename } from "node:fs/promises"
import { join } from "node:path"
import * as z from "zod"
import { readJson, writeJson } from "../json.ts"
import {
  agentResultSchema,
  type Coverage,
  coverageSchema,
  coverageTools,
  type SuiteResult,
  suiteResultSchema,
} from "../registries.ts"
import { mergeEnv, runFiles, stagesSchema } from "../run-folder.ts"
import { coverageSummary } from "./coverage.ts"

export async function finalize(runDir: string) {
  const stages = stagesSchema.parse(await readJson(join(runDir, runFiles.stages)))
  const agent = await readIfThere(join(runDir, runFiles.agent), agentResultSchema)
  const suite = await readIfThere(join(runDir, runFiles.results, "fixed.json"), suiteResultSchema)
  const coverage = await readIfThere(
    join(runDir, runFiles.coverage, coverageSummary),
    z.record(z.string(), coverageSchema.nullable()),
  )
  const failed = Object.entries(stages).find(([, stage]) => stage.error !== undefined)
  const count = (status: SuiteResult["tests"][number]["status"]) => suite?.tests.filter(test => test.status === status).length
  const metrics = {
    status: failed || !agent ? "infra_error" : agent.status,
    stop_reason: agent?.stop_reason ?? null,
    error: failed ? `${failed[0]}: ${failed[1].error}` : (agent?.error ?? null),
    tokens: agent?.tokens ?? null,
    cost_usd: agent?.cost_usd ?? null,
    cost_source: agent?.cost_source ?? null,
    turns: agent?.turns ?? null,
    models: agent?.models ?? null,
    wall_ms: Object.fromEntries(Object.entries(stages).map(([name, stage]) => [name, stage.ms])),
    n_tests: suite ? suite.tests.length : null,
    fixed: suite ? { passed: count("passed"), failed: count("failed"), flaky: count("flaky"), skipped: count("skipped") } : null,
    coverage: Object.fromEntries(coverageTools.map(({ name }) => [name, coverageBlock(coverage?.[name])])),
    signal_calls: await countRecords(join(runDir, runFiles.signalCalls)),
  }
  await mergeEnv(runDir, { ended_at: new Date().toISOString() })
  const file = join(runDir, runFiles.metrics)
  await writeJson(`${file}.partial`, metrics)
  await rename(`${file}.partial`, file)
  return metrics
}

export type Metrics = Awaited<ReturnType<typeof finalize>>

function coverageBlock(coverage: Coverage | null | undefined) {
  return coverage ? { covered: coverage.covered, total: coverage.total, pct: coverage.pct, report: coverage.report } : null
}

async function countRecords(file: string) {
  return existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean).length : 0
}

async function readIfThere<T extends z.ZodType>(file: string, schema: T) {
  return existsSync(file) ? schema.parse(await readJson(file)) : undefined
}
