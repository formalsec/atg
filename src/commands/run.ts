import { existsSync } from "node:fs"
import { mkdir, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import * as z from "zod"
import { findApp, loadApps } from "../apps.ts"
import { configSchema } from "../config.ts"
import { readJson } from "../json.ts"
import { identify } from "../run-id.ts"
import { removeWorkspace, runFiles, runStage, stopOnSignals } from "../run-folder.ts"
import { finalize } from "../stages/finalize.ts"
import { agentInvocation, commandLine, generate } from "../stages/generate.ts"
import { prepare } from "../stages/prepare.ts"
import { evaluationStages, printMetrics, runEvaluation } from "./eval.ts"

type Options = { dryRun?: boolean; force?: boolean; runsDir: string; keepWorkspace?: boolean }

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
  stopOnSignals(runDir, options.keepWorkspace)

  const prepareError = await runStage(runDir, "prepare", () => prepare(runDir, config, app, versions))
  if (options.dryRun) {
    if (prepareError) throw new Error(`prepare failed: ${prepareError}`)
    const invocation = await agentInvocation(runDir)
    const promptFile = join(runDir, runFiles.prompt)
    console.log(`run_id ${id} (dry run, the agent was not called)`)
    console.log(`run folder ${runDir}\nworkspace ${invocation.cwd}\nprompt ${promptFile}\nisolation ${invocation.isolation}`)
    console.log(`invocation\n${commandLine(invocation, promptFile)}`)
    return
  }
  try {
    const generated = !prepareError && (await runStage(runDir, "generate", () => generate(runDir))) === undefined
    if (generated) await runEvaluation(runDir, Object.keys(evaluationStages))
  } finally {
    if (!options.keepWorkspace) removeWorkspace(runDir)
  }
  const metrics = await finalize(runDir)
  printMetrics(id, runDir, metrics)
  if (metrics.status === "infra_error") process.exitCode = 1
}
