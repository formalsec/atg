import { existsSync } from "node:fs"
import { join } from "node:path"
import * as z from "zod"
import { findApp, loadApps } from "./apps.ts"
import { configSchema } from "./config.ts"
import { readJson, writeJson } from "./json.ts"

export const runFiles = {
  config: "config.json",
  prompt: "prompt.md",
  env: "env.json",
  stages: "stages.json",
  agent: "agent.json",
  agentStdout: "agent-stdout.txt",
  agentStderr: "agent-stderr.txt",
  tests: "tests",
  results: "results",
  metrics: "metrics.json",
}

const envSchema = z.object({
  started_at: z.string(),
  workspace: z.string(),
  app: z.object({ fixed: z.object({ sha: z.string() }) }),
})

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
