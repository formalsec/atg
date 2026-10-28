import { log } from "@clack/prompts"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { constants } from "node:os"
import { join } from "node:path"
import * as z from "zod"
import { findApp, loadApps } from "./apps.ts"
import { configSchema } from "./config.ts"
import { readJson, writeJson } from "./json.ts"
import { killAll } from "./process.ts"
import { removeTempDirs } from "./temp.ts"

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

export const progress = { output: process.stderr }

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

export async function runStage(runDir: string, name: string, work: () => Promise<void>) {
  log.info(name, progress)
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
  if (error === undefined) log.success(`${name} ${duration(ms)}`, { ...progress, spacing: 0 })
  else log.error(`${name} failed after ${duration(ms)}: ${error}`, { ...progress, spacing: 0 })
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
