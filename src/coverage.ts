import { mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { App } from "./apps.ts"
import { type Coverage, type CoverageAdapter, frameworkEntry } from "./registries.ts"
import { exportVersion } from "./repo.ts"
import { tempDir } from "./temp.ts"

type Measurement = {
  tools: { name: string; adapter: CoverageAdapter }[]
  app: App
  sha: string
  framework: string
  testsDir: string
  baseUrl: string
  outDir: string
  timeoutMs: number
}

export async function measure({ tools, app, sha, framework, testsDir, baseUrl, outDir, timeoutMs }: Measurement) {
  const source = await tempDir("atg-source-")
  try {
    await exportVersion(app, sha, source)
    const runs = tools.map(({ name, adapter }) => ({ name, adapter, run: { app, source, baseUrl, dir: join(outDir, name) } }))
    for (const { adapter, run } of runs) {
      await mkdir(run.dir, { recursive: true })
      await adapter.universe?.(run)
    }
    await frameworkEntry(framework).adapter.run({
      testsDir,
      baseUrl,
      reportFile: join(outDir, "suite-report.json"),
      logFile: join(outDir, "suite.log"),
      timeoutMs,
      collectors: runs.flatMap(({ adapter, run }) => (adapter.collector ? [{ module: adapter.collector, dir: run.dir }] : [])),
    })
    const results: Record<string, Coverage | null> = {}
    for (const { name, adapter, run } of runs) results[name] = await adapter.report(run)
    return results
  } finally {
    await rm(source, { recursive: true, force: true })
  }
}
