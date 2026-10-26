import { existsSync } from "node:fs"
import { readFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import * as z from "zod"
import { buggyVerdicts, type Classification, caught, caughtStrict, classify, fixedVerdicts } from "../classify.ts"
import { readJson, writeJson } from "../json.ts"
import { agentResultSchema, type Coverage, coverageSchema, coverageTools } from "../registries.ts"
import { mergeEnv, runFiles, stagesSchema } from "../run-folder.ts"
import { coverageSummary } from "./coverage.ts"
import { protocolVersion, repetitionsFile, repetitionsSchema } from "./evaluate.ts"

type Repetitions = z.infer<typeof repetitionsSchema>

export async function finalize(runDir: string) {
  const stages = stagesSchema.parse(await readJson(join(runDir, runFiles.stages)))
  const agent = await readIfThere(join(runDir, runFiles.agent), agentResultSchema)
  const results = join(runDir, runFiles.results)
  const fixedRuns = await readIfThere(join(results, "fixed", repetitionsFile), repetitionsSchema)
  const buggyRuns = await readIfThere(join(results, "buggy", repetitionsFile), repetitionsSchema)
  const bugRuns = await readIfThere(join(results, "bugs", repetitionsFile), z.record(z.string(), repetitionsSchema))
  const coverage = await readIfThere(
    join(runDir, runFiles.coverage, coverageSummary),
    z.record(z.string(), coverageSchema.nullable()),
  )
  const failed = Object.entries(stages).find(([, stage]) => stage.error !== undefined)
  const main = fixedRuns && classify(tests(fixedRuns), tests(buggyRuns ?? []))
  const byBug =
    fixedRuns && bugRuns
      ? Object.entries(bugRuns).map(([id, runs]) => ({ id, result: classify(tests(fixedRuns), tests(runs)) }))
      : []
  const verdictsFile = join(results, "verdicts.json")
  await (main ? writeJson(verdictsFile, verdicts(main, byBug)) : rm(verdictsFile, { force: true }))
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
    repetition_ms: {
      fixed: fixedRuns ? durations(fixedRuns) : null,
      buggy: buggyRuns ? durations(buggyRuns) : null,
      bugs: bugRuns ? Object.fromEntries(Object.entries(bugRuns).map(([id, runs]) => [id, durations(runs)])) : null,
    },
    evaluation: { protocol: protocolVersion, reruns: fixedRuns?.length ?? null },
    n_tests: fixedRuns ? Math.max(0, ...fixedRuns.map(run => run.tests.length)) : null,
    duplicate_keys: main?.duplicates ?? null,
    fixed: main ? tally(main.tests.map(test => test.fixed), fixedVerdicts) : null,
    buggy: main && buggyRuns ? tally(main.tests.map(test => test.buggy), buggyVerdicts) : null,
    caught: main && buggyRuns ? caught(main.tests) : null,
    caught_strict: main && buggyRuns ? caughtStrict(main) : null,
    not_caught_reason: main && buggyRuns && !caught(main.tests) ? notCaughtReason(main) : null,
    bugs: main && bugRuns ? detection(byBug) : null,
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

function tests(runs: Repetitions) {
  return runs.map(run => run.tests)
}

function durations(runs: Repetitions) {
  return runs.map(run => run.ms)
}

function tally(verdicts: (string | undefined)[], names: readonly string[]) {
  return Object.fromEntries(names.map(name => [name, verdicts.filter(verdict => verdict === name).length]))
}

function notCaughtReason({ tests }: Classification) {
  if (!tests.some(test => test.fixed === "stable_pass")) return "no test is stable_pass on fixed"
  return "no stable_pass test fails on buggy in every repetition"
}

function detection(byBug: { id: string; result: Classification }[]) {
  const detected = byBug.filter(({ result }) => caught(result.tests)).length
  return {
    tested: byBug.length,
    detected,
    detection_rate: detected / byBug.length,
    by_bug: Object.fromEntries(byBug.map(({ id, result }) => [id, tally(result.tests.map(test => test.buggy), buggyVerdicts)])),
  }
}

function verdicts(main: Classification, byBug: { id: string; result: Classification }[]) {
  return {
    duplicates: main.duplicates,
    tests: main.tests.map(test => {
      const bugs = byBug.flatMap(({ id, result }) => {
        const verdict = result.tests.find(other => other.key === test.key)?.buggy
        return verdict ? [[id, verdict]] : []
      })
      return bugs.length > 0 ? { ...test, bugs: Object.fromEntries(bugs) } : test
    }),
  }
}

function coverageBlock(coverage: Coverage | null | undefined) {
  return coverage ? { covered: coverage.covered, total: coverage.total, pct: coverage.pct, report: coverage.report } : null
}

async function countRecords(file: string) {
  return existsSync(file) ? (await readFile(file, "utf8")).split("\n").filter(Boolean).length : 0
}

async function readIfThere<T extends z.ZodType>(file: string, schema: T) {
  return existsSync(file) ? schema.parse(await readJson(file)) : undefined
}
