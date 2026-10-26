import { existsSync } from "node:fs"
import { rename } from "node:fs/promises"
import { join } from "node:path"
import * as z from "zod"
import { readJson, writeJson } from "../json.ts"
import { agentResultSchema, type SuiteResult, suiteResultSchema } from "../registries.ts"
import { mergeEnv, runFiles } from "../run-folder.ts"

const stagesSchema = z.record(z.string(), z.object({ ms: z.number(), error: z.string().optional() }))

export async function finalize(runDir: string) {
  const stages = stagesSchema.parse(await readJson(join(runDir, runFiles.stages)))
  const agent = await readIfThere(join(runDir, runFiles.agent), agentResultSchema)
  const suite = await readIfThere(join(runDir, runFiles.results, "fixed.json"), suiteResultSchema)
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
  }
  await mergeEnv(runDir, { ended_at: new Date().toISOString() })
  const file = join(runDir, runFiles.metrics)
  await writeJson(`${file}.partial`, metrics)
  await rename(`${file}.partial`, file)
  return metrics
}

async function readIfThere<T extends z.ZodType>(file: string, schema: T) {
  return existsSync(file) ? schema.parse(await readJson(file)) : undefined
}
