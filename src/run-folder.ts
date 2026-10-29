import { existsSync, readFileSync, rmSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { constants, tmpdir } from "node:os"
import { join } from "node:path"
import * as z from "zod"
import { configSchema, findApp, loadApps } from "./config.ts"
import { killAll } from "./process.ts"

export const runFiles = {
  config: "config.json",
  prompt: "prompt.md",
  env: "env.json",
  stages: "stages.json",
  agent: "agent.json",
  agentStdout: "agent-stdout.txt",
  agentStderr: "agent-stderr.txt",
  signalCalls: "signal-calls.jsonl",
  tests: "tests",
  results: "results",
  coverage: join("results", "coverage"),
  metrics: "metrics.json",
}

const envSchema = z.object({
  started_at: z.string(),
  workspace: z.string(),
  app: z.object({ fixed: z.object({ sha: z.string() }), buggy: z.object({ sha: z.string() }) }),
})

export const stagesSchema = z.record(z.string(), z.object({ ms: z.number(), error: z.string().optional() }))

const stopSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]

const tempDirs = new Set<string>()

process.once("exit", removeTempDirs)

export async function readRun(runDir: string) {
  const apps = await loadApps()
  const config = configSchema(apps).parse(await readJson(join(runDir, runFiles.config)))
  const env = envSchema.parse(await readJson(join(runDir, runFiles.env)))
  const deadline = Date.parse(env.started_at) + config.timeout_min * 60_000
  return { config, env, app: findApp(apps, config.app), deadline }
}

export async function mergeEnv(runDir: string, fields: Record<string, unknown>) {
  const file = join(runDir, runFiles.env)
  const current = existsSync(file) ? z.record(z.string(), z.unknown()).parse(await readJson(file)) : {}
  await writeJson(file, { ...current, ...fields })
}

export async function runStage(runDir: string, name: string, purpose: string, work: () => Promise<void>) {
  console.error(`${name}: ${purpose}`)
  const started = performance.now()
  const error = await work().then(
    () => undefined,
    (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
  )
  const ms = Math.round(performance.now() - started)
  const file = join(runDir, runFiles.stages)
  const stages = existsSync(file) ? stagesSchema.parse(await readJson(file)) : {}
  stages[name] = { ms, error }
  await writeJson(file, stages)
  console.error(error === undefined ? `${name} done in ${duration(ms)}` : `${name} failed after ${duration(ms)}: ${error}`)
  return error
}

export function duration(ms: number) {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)} s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`
  if (seconds < 48 * 3600) return `${(seconds / 3600).toFixed(1)} h`
  return `${(seconds / 86_400).toFixed(1)} days`
}

export function stopOnSignals(runDir: string, keepWorkspace = false) {
  for (const name of stopSignals) {
    process.once(name, () => {
      killAll()
      removeTempDirs()
      if (!keepWorkspace) removeWorkspace(runDir)
      process.exit(128 + constants.signals[name])
    })
  }
}

export function removeWorkspace(runDir: string) {
  try {
    const env = JSON.parse(readFileSync(join(runDir, runFiles.env), "utf8"))
    rmSync(z.object({ workspace: z.string() }).parse(env).workspace, { recursive: true, force: true })
  } catch {}
}

export async function readJson(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8")
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error}`)
  }
}

export async function writeJson(file: string, value: unknown) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.add(dir)
  return dir
}

function removeTempDirs() {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.clear()
}
