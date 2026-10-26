import { realpathSync } from "node:fs"
import { appendFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { appsDir } from "../apps.ts"
import { measure } from "../coverage.ts"
import { quote } from "../process.ts"
import { type Coverage, coverageTools, frameworkEntry } from "../registries.ts"
import { readRun, runFiles, stopOnSignals } from "../run-folder.ts"
import { tempDir } from "../temp.ts"

export const signalCommand = "./coverage"

export async function installSignal(workspace: string, runDir: string) {
  const atg = [process.execPath, realpathSync(process.argv[1]), "signal", runDir].map(quote).join(" ")
  await writeFile(join(workspace, signalCommand), `#!/bin/sh\nATG_APPS_DIR=${quote(appsDir)} exec ${atg}\n`, { mode: 0o755 })
}

export async function signal(runDir: string) {
  const { config, env, app, deadline } = await readRun(runDir)
  if (app.url === undefined) throw new Error(`app "${app.id}" has no url to test against`)
  stopOnSignals(runDir, true)
  await appendFile(join(runDir, runFiles.signalCalls), `${JSON.stringify({ at: new Date().toISOString() })}\n`)
  const tools = coverageTools.filter(tool => config.coverage_signal.includes(tool.name))
  const outDir = await tempDir("atg-signal-")
  try {
    const results = await measure({
      tools,
      app,
      sha: env.app.fixed.sha,
      framework: config.framework,
      testsDir: join(env.workspace, frameworkEntry(config.framework).adapter.testDir),
      baseUrl: app.url,
      outDir,
      timeoutMs: deadline - Date.now(),
    })
    for (const tool of tools) console.log(describe(tool.label, results[tool.name]))
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
}

function describe(label: string, coverage: Coverage | null) {
  if (!coverage) return `${label}: not measured`
  const uncovered = coverage.uncovered.map(item => `  ${item}`)
  return [`${label}: ${coverage.pct}% (${coverage.covered} of ${coverage.total})`, ...uncovered].join("\n")
}
