import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { startApp } from "../app-runtime.ts"
import { writeJson } from "../json.ts"
import { frameworkEntry } from "../registries.ts"
import { mergeEnv, readRun, runFiles } from "../run-folder.ts"

export async function evaluate(runDir: string) {
  const { config, env, app } = await readRun(runDir)
  const results = join(runDir, runFiles.results)
  await mkdir(results, { recursive: true })
  const instance = await startApp(app, env.app.fixed.sha, join(results, "fixed-app.log"))
  try {
    const { versions, ...suite } = await frameworkEntry(config.framework).adapter.run({
      testsDir: join(runDir, runFiles.tests),
      baseUrl: instance.url,
      reportFile: join(results, "fixed-report.json"),
      logFile: join(results, "fixed-run.log"),
      timeoutMs: config.timeout_min * 60_000,
    })
    await writeJson(join(results, "fixed.json"), suite)
    await mergeEnv(runDir, { framework: { name: config.framework, versions } })
  } finally {
    await instance.stop()
  }
}
