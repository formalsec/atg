import { existsSync, readFileSync, rmSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { constants } from "node:os"
import { join, resolve } from "node:path"
import * as z from "zod"
import { findApp, loadApps } from "../apps.ts"
import { configSchema } from "../config.ts"
import { readJson, writeJson } from "../json.ts"
import { killAll } from "../process.ts"
import { identify } from "../run-id.ts"
import { runFiles } from "../run-folder.ts"
import { evaluate } from "../stages/evaluate.ts"
import { finalize } from "../stages/finalize.ts"
import { agentInvocation, commandLine, generate } from "../stages/generate.ts"
import { prepare } from "../stages/prepare.ts"
import { removeTempDirs } from "../temp.ts"

type Options = { dryRun?: boolean; force?: boolean; runsDir: string; keepWorkspace?: boolean }

const stopSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"]

export async function run(file: string, options: Options) {
  const apps = await loadApps()
  const parsed = configSchema(apps).safeParse(await readJson(file))
  if (!parsed.success) throw new Error(`${file} is not a valid config\n${z.prettifyError(parsed.error)}`)
  const config = parsed.data
  const app = findApp(apps, config.app)
  const { id, versions } = await identify(config, app)
  const runDir = resolve(options.runsDir, id)
  if (existsSync(join(runDir, runFiles.metrics)) && !options.force) {
    console.log(`run_id ${id} is done, nothing to do (--force redoes it)\n${runDir}`)
    return
  }
  await rm(runDir, { recursive: true, force: true })
  await mkdir(runDir, { recursive: true })
  for (const name of stopSignals) process.once(name, () => stop(name, runDir, options.keepWorkspace))

  const stages: Record<string, { ms: number; error?: string }> = {}
  const stage = async (name: string, work: () => Promise<void>) => {
    const started = performance.now()
    const error = await work().then(
      () => undefined,
      (failure: unknown) => (failure instanceof Error ? failure.message : String(failure)),
    )
    stages[name] = { ms: Math.round(performance.now() - started), error }
    await writeJson(join(runDir, runFiles.stages), stages)
    return error === undefined
  }

  const prepared = await stage("prepare", () => prepare(runDir, config, app, versions))
  if (options.dryRun) {
    if (!prepared) throw new Error(`prepare failed: ${stages.prepare.error}`)
    const invocation = await agentInvocation(runDir)
    const promptFile = join(runDir, runFiles.prompt)
    console.log(`run_id ${id} (dry run, the agent was not called)`)
    console.log(`run folder ${runDir}\nworkspace ${invocation.cwd}\nprompt ${promptFile}\nisolation ${invocation.isolation}`)
    console.log(`invocation\n${commandLine(invocation, promptFile)}`)
    return
  }
  try {
    if (prepared && (await stage("generate", () => generate(runDir)))) await stage("evaluate", () => evaluate(runDir))
  } finally {
    if (!options.keepWorkspace) removeWorkspace(runDir)
  }
  const metrics = await finalize(runDir)
  const fixed = metrics.fixed
  console.log(
    [
      `run_id ${id}`,
      `status ${metrics.status}${metrics.stop_reason ? ` (${metrics.stop_reason})` : ""}`,
      ...(metrics.error ? [`error ${metrics.error}`] : []),
      fixed
        ? `fixed: ${metrics.n_tests} tests, ${fixed.passed} passed, ${fixed.failed} failed, ${fixed.flaky} flaky`
        : "fixed: not evaluated",
      `cost ${metrics.cost_usd ?? "unknown"} USD (${metrics.cost_source ?? "no result"}), ${metrics.turns ?? "?"} turns`,
      runDir,
    ].join("\n"),
  )
  if (metrics.status === "infra_error") process.exitCode = 1
}

function stop(signal: NodeJS.Signals, runDir: string, keepWorkspace = false) {
  killAll()
  removeTempDirs()
  if (!keepWorkspace) removeWorkspace(runDir)
  process.exit(128 + constants.signals[signal])
}

function removeWorkspace(runDir: string) {
  try {
    const env = JSON.parse(readFileSync(join(runDir, runFiles.env), "utf8"))
    rmSync(z.object({ workspace: z.string() }).parse(env).workspace, { recursive: true, force: true })
  } catch {}
}
