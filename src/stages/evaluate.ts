import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import * as z from "zod"
import { startApp } from "../app-runtime.ts"
import { classify } from "../classify.ts"
import { readJson, writeJson } from "../json.ts"
import { frameworkEntry, suiteResultSchema } from "../registries.ts"
import { resolveRefs } from "../repo.ts"
import { mergeEnv, readRun, runFiles } from "../run-folder.ts"

export const protocolVersion = 1

export const defaultReruns = 3

export const repetitionsFile = "repetitions.json"

export const repetitionsSchema = z.array(suiteResultSchema.extend({ ms: z.number() }))

type Run = Awaited<ReturnType<typeof readRun>>

type Version = { sha: string; dir: string; reruns: number; only?: string[] }

export async function fixed(runDir: string, reruns: number) {
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

export async function buggy(runDir: string, reruns: number) {
  const run = await readRun(runDir)
  const only = await stableTests(runDir, reruns)
  const dir = join(runDir, runFiles.results, "buggy")
  const { repetitions } = await repeat(runDir, run, { sha: run.env.app.buggy.sha, dir, reruns, only })
  await writeJson(join(dir, repetitionsFile), repetitions)
}

export async function bugs(runDir: string, reruns: number) {
  const run = await readRun(runDir)
  const dir = join(runDir, runFiles.results, "bugs")
  await rm(dir, { recursive: true, force: true })
  const list = run.app.bugs
  if (list === undefined) return
  const only = await stableTests(runDir, reruns)
  const shas = await resolveRefs(run.app, list.map(bug => bug.ref))
  await mergeEnv(runDir, { bugs: list.map((bug, index) => ({ id: bug.id, ref: bug.ref, sha: shas[index] })) })
  const results: Record<string, z.infer<typeof repetitionsSchema>> = {}
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
  const repetitions: z.infer<typeof repetitionsSchema> = []
  let versions: Record<string, string> = {}
  const count = only?.length === 0 ? 0 : reruns
  for (let n = 1; n <= count; n++) {
    const started = performance.now()
    const instance = await startApp(app, sha, join(dir, `${n}-app.log`))
    const result = await frameworkEntry(config.framework)
      .adapter.run({
        testsDir: join(runDir, runFiles.tests),
        baseUrl: instance.url,
        reportFile: join(dir, `${n}-report.json`),
        logFile: join(dir, `${n}-run.log`),
        timeoutMs: config.timeout_min * 60_000,
        collectors: [],
        only,
      })
      .finally(instance.stop)
    const missing = only?.filter(key => !result.tests.some(test => test.key === key)) ?? []
    if (missing.length > 0) throw new Error(`the suite run did not report the selected tests: ${missing.join(", ")}`)
    repetitions.push({ ms: Math.round(performance.now() - started), tests: result.tests, errors: result.errors })
    versions = result.versions
  }
  return { repetitions, versions }
}
