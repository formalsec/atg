import { mkdir, rm } from "node:fs/promises"
import { join, relative } from "node:path"
import { startApp } from "../app-runtime.ts"
import { measure } from "../coverage.ts"
import { writeJson } from "../json.ts"
import { coverageTools } from "../registries.ts"
import { readRun, runFiles } from "../run-folder.ts"

export const coverageSummary = "summary.json"

export async function coverage(runDir: string) {
  const { config, env, app } = await readRun(runDir)
  const outDir = join(runDir, runFiles.coverage)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  const instance = await startApp(app, env.app.fixed.sha, join(outDir, "fixed-app.log"))
  try {
    const results = await measure({
      tools: coverageTools.filter(tool => tool.implemented),
      app,
      sha: env.app.fixed.sha,
      framework: config.framework,
      testsDir: join(runDir, runFiles.tests),
      baseUrl: instance.url,
      outDir,
      timeoutMs: config.timeout_min * 60_000,
    })
    const summary = Object.entries(results).map(([name, result]) => [
      name,
      result && { ...result, report: relative(runDir, result.report) },
    ])
    await writeJson(join(outDir, coverageSummary), Object.fromEntries(summary))
  } finally {
    await instance.stop()
  }
}
