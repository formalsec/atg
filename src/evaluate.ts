import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import * as z from "zod"
import { holdUrl, resolveRefs, startApp } from "./app.ts"
import { agentResultSchema } from "./claude.ts"
import { type Coverage, coverage, coverageSchema, coverageSummary } from "./coverage.ts"
import * as playwright from "./playwright.ts"
import { mergeEnv, readJson, readRun, runFiles, runStage, stagesSchema, stopOnSignals, writeJson } from "./run-folder.ts"

const protocolVersion = 1

export const defaultReruns = 3

const repetitionsFile = "repetitions.json"

const repetitionsSchema = z.array(playwright.suiteResultSchema.extend({ ms: z.number() }))

type Repetitions = z.infer<typeof repetitionsSchema>

type Run = Awaited<ReturnType<typeof readRun>>

type Version = { sha: string; dir: string; reruns: number; only?: string[] }

type Status = playwright.SuiteResult["tests"][number]["status"]
type Repetition = { key: string; status: Status }[]

const fixedVerdicts = ["stable_pass", "broken", "flaky", "skipped"] as const
const buggyVerdicts = ["revealing", "flaky_on_buggy", "not_revealing"] as const

type Verdict = {
  key: string
  fixed: (typeof fixedVerdicts)[number]
  buggy?: (typeof buggyVerdicts)[number]
}

type Classification = { tests: Verdict[]; duplicates: string[] }

export const evaluationStages: Record<string, (runDir: string, reruns: number) => Promise<void>> = {
  fixed,
  buggy,
  bugs,
  coverage,
}

type Options = { only?: string; reruns: number; runsDir: string }

export async function evaluateRun(runId: string, options: Options) {
  const runDir = resolve(options.runsDir, runId)
  const stages = join(runDir, runFiles.stages)
  const generated = existsSync(stages) ? stagesSchema.parse(await readJson(stages)).generate : undefined
  if (!generated || generated.error !== undefined) {
    throw new Error(`run ${runId} has no suite to evaluate: its generate stage did not finish in ${runDir}`)
  }
  stopOnSignals(runDir, true)
  const release = await holdUrl((await readRun(runDir)).app.url)
  try {
    await runEvaluation(runDir, options.only ? [options.only] : Object.keys(evaluationStages), options.reruns)
  } finally {
    await release()
  }
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
  const measured = Object.entries(metrics.coverage).map(([name, block]) => `${name} ${block ? `${block.pct}%` : "not measured"}`)
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
      `coverage: ${measured.join(", ")}`,
      `cost ${metrics.cost_usd ?? "unknown"} USD (${metrics.cost_source ?? "no result"}), ${metrics.turns ?? "?"} turns`,
      runDir,
    ].join("\n"),
  )
}

async function fixed(runDir: string, reruns: number) {
  const run = await readRun(runDir)
  const results = join(runDir, runFiles.results)
  for (const stale of ["buggy", "bugs"]) await rm(join(results, stale), { recursive: true, force: true })
  const dir = join(results, "fixed")
  const { repetitions, versions } = await repeat(runDir, run, { sha: run.env.app.fixed.sha, dir, reruns })
  await writeJson(join(dir, repetitionsFile), repetitions)
  await mergeEnv(runDir, {
    framework: { name: run.config.framework, versions },
    evaluation: { protocol: protocolVersion, reruns },
  })
}

async function buggy(runDir: string, reruns: number) {
  const run = await readRun(runDir)
  const only = await stableTests(runDir, reruns)
  const dir = join(runDir, runFiles.results, "buggy")
  const { repetitions } = await repeat(runDir, run, { sha: run.env.app.buggy.sha, dir, reruns, only })
  await writeJson(join(dir, repetitionsFile), repetitions)
}

async function bugs(runDir: string, reruns: number) {
  const run = await readRun(runDir)
  const dir = join(runDir, runFiles.results, "bugs")
  await rm(dir, { recursive: true, force: true })
  const list = run.app.bugs
  if (list === undefined) return
  const only = await stableTests(runDir, reruns)
  const shas = await resolveRefs(run.app, list.map(bug => bug.ref))
  await mergeEnv(runDir, { bugs: list.map((bug, index) => ({ id: bug.id, ref: bug.ref, sha: shas[index] })) })
  const results: Record<string, Repetitions> = {}
  for (const [index, bug] of list.entries()) {
    results[bug.id] = (await repeat(runDir, run, { sha: shas[index], dir: join(dir, bug.id), reruns, only })).repetitions
  }
  await writeJson(join(dir, repetitionsFile), results)
}

async function stableTests(runDir: string, reruns: number) {
  const file = join(runDir, runFiles.results, "fixed", repetitionsFile)
  if (!existsSync(file)) throw new Error("there are no saved fixed results, run the fixed stage first")
  const fixedRuns = repetitionsSchema.parse(await readJson(file))
  if (fixedRuns.length !== reruns) {
    throw new Error(`the saved fixed results come from --reruns ${fixedRuns.length}, not ${reruns}: give --reruns ${fixedRuns.length} or run the fixed stage again`)
  }
  const { tests } = classify(fixedRuns.map(run => run.tests), [])
  return tests.filter(test => test.fixed === "stable_pass").map(test => test.key)
}

async function repeat(runDir: string, { config, app }: Run, { sha, dir, reruns, only }: Version) {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const repetitions: Repetitions = []
  let versions: Record<string, string> = {}
  const count = only?.length === 0 ? 0 : reruns
  for (let n = 1; n <= count; n++) {
    const started = performance.now()
    const instance = await startApp(app, sha, join(dir, `${n}-app.log`))
    const result = await playwright
      .run({
        testsDir: join(runDir, runFiles.tests),
        baseUrl: instance.url,
        reportFile: join(dir, `${n}-report.json`),
        logFile: join(dir, `${n}-run.log`),
        timeoutMs: config.timeout_min * 60_000,
        collectors: [],
      })
      .finally(instance.stop)
    const tests = only ? result.tests.filter(test => only.includes(test.key)) : result.tests
    const missing = only?.filter(key => !tests.some(test => test.key === key)) ?? []
    if (missing.length > 0) throw new Error(`the suite run did not report the selected tests: ${missing.join(", ")}`)
    repetitions.push({ ms: Math.round(performance.now() - started), tests, errors: result.errors })
    versions = result.versions
  }
  return { repetitions, versions }
}

export function classify(fixed: Repetition[], buggy: Repetition[]): Classification {
  const duplicates = [...new Set(fixed.flatMap(repeatedKeys))]
  const keys = [...new Set(fixed.flat().map(test => test.key))].filter(key => !duplicates.includes(key))
  const tests = keys.map((key): Verdict => {
    const verdict = fixedVerdict(statuses(fixed, key))
    if (verdict !== "stable_pass" || buggy.length === 0) return { key, fixed: verdict }
    return { key, fixed: verdict, buggy: buggyVerdict(statuses(buggy, key)) }
  })
  return { tests, duplicates }
}

export function caught(tests: Verdict[]) {
  return tests.some(test => test.buggy === "revealing")
}

export function caughtStrict({ tests, duplicates }: Classification) {
  return duplicates.length === 0 && tests.every(test => test.fixed === "stable_pass") && caught(tests)
}

function repeatedKeys(repetition: Repetition) {
  const keys = repetition.map(test => test.key)
  return keys.filter((key, index) => keys.indexOf(key) !== index)
}

function statuses(repetitions: Repetition[], key: string) {
  return repetitions.map(repetition => repetition.find(test => test.key === key)?.status ?? "failed")
}

function failed(status: Status) {
  return status !== "passed" && status !== "skipped"
}

function fixedVerdict(statuses: Status[]) {
  if (statuses.every(status => status === "passed")) return "stable_pass"
  if (statuses.every(status => status === "skipped")) return "skipped"
  if (statuses.every(failed)) return "broken"
  return "flaky"
}

function buggyVerdict(statuses: Status[]) {
  if (statuses.every(failed)) return "revealing"
  if (!statuses.some(failed)) return "not_revealing"
  return "flaky_on_buggy"
}

export async function finalize(runDir: string) {
  const stages = stagesSchema.parse(await readJson(join(runDir, runFiles.stages)))
  const agent = await readIfThere(join(runDir, runFiles.agent), agentResultSchema)
  const results = join(runDir, runFiles.results)
  const fixedRuns = await readIfThere(join(results, "fixed", repetitionsFile), repetitionsSchema)
  const buggyRuns = await readIfThere(join(results, "buggy", repetitionsFile), repetitionsSchema)
  const bugRuns = await readIfThere(join(results, "bugs", repetitionsFile), z.record(z.string(), repetitionsSchema))
  const summary = await readIfThere(
    join(runDir, runFiles.coverage, coverageSummary),
    z.object({ lines: coverageSchema.nullable(), api: coverageSchema.nullish(), html: coverageSchema.nullish() }),
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
    coverage: { lines: coverageBlock(summary?.lines), html: coverageBlock(summary?.html), api: coverageBlock(summary?.api) },
    signal_calls: await countRecords(join(runDir, runFiles.signalCalls)),
  }
  await mergeEnv(runDir, { ended_at: new Date().toISOString() })
  const file = join(runDir, runFiles.metrics)
  await writeJson(`${file}.partial`, metrics)
  await rename(`${file}.partial`, file)
  return metrics
}

type Metrics = Awaited<ReturnType<typeof finalize>>

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
