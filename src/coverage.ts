import { existsSync, realpathSync } from "node:fs"
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, posix, relative } from "node:path"
import MCR from "monocart-coverage-reports"
import * as z from "zod"
import { exportVersion, startApp } from "./app.ts"
import { type App, appsDir, type Config } from "./config.ts"
import { rawDir } from "./coverage-collector.ts"
import * as playwright from "./playwright.ts"
import { quote } from "./process.ts"
import { readJson, readRun, runFiles, stopOnSignals, tempDir, writeJson } from "./run-folder.ts"

export const coverageSchema = z.object({
  covered: z.number(),
  total: z.number(),
  pct: z.number(),
  report: z.string(),
  uncovered: z.array(z.string()),
})

export type Coverage = z.infer<typeof coverageSchema>

export const coverageSummary = "summary.json"

export const signalCommand = "./coverage"

const collectors = {
  lines: join(import.meta.dirname, "coverage-collector.ts"),
  api: join(import.meta.dirname, "api-collector.ts"),
}

const labels = { lines: "Browser-side line coverage", api: "API endpoint coverage" }

const pageLoads = ["document", "stylesheet", "script", "image", "font", "media", "texttrack", "manifest"]

const requestsSchema = z.array(
  z.object({ method: z.string(), url: z.string(), type: z.string(), unserved: z.string().optional() }),
)

type Measurement = {
  app: App
  sha: string
  testsDir: string
  baseUrl: string
  outDir: string
  timeoutMs: number
  types: Config["coverage_signal"]
}

export async function coverage(runDir: string) {
  const { config, env, app } = await readRun(runDir)
  const outDir = join(runDir, runFiles.coverage)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  const instance = await startApp(app, env.app.fixed.sha, join(outDir, "fixed-app.log"))
  try {
    const { lines, api } = await measure({
      app,
      sha: env.app.fixed.sha,
      testsDir: join(runDir, runFiles.tests),
      baseUrl: instance.url,
      outDir,
      timeoutMs: config.timeout_min * 60_000,
      types: ["lines", "api"],
    })
    const inRun = (result: Coverage | null) => result && { ...result, report: relative(runDir, result.report) }
    await writeJson(join(outDir, coverageSummary), { lines: inRun(lines), api: inRun(api) })
  } finally {
    await instance.stop()
  }
}

export async function installSignal(workspace: string, runDir: string) {
  const atg = [process.execPath, realpathSync(process.argv[1]), "signal", runDir].map(quote).join(" ")
  await writeFile(join(workspace, signalCommand), `#!/bin/sh\nATG_APPS_DIR=${quote(appsDir)} exec ${atg}\n`, { mode: 0o755 })
}

export async function signal(runDir: string) {
  const { config, env, app, deadline } = await readRun(runDir)
  stopOnSignals(runDir, true)
  await appendFile(join(runDir, runFiles.signalCalls), `${JSON.stringify({ at: new Date().toISOString() })}\n`)
  const instance = config.inputs.includes("url")
    ? undefined
    : await startApp(app, env.app.fixed.sha, join(runDir, "app-signal.log"))
  const outDir = await tempDir("atg-signal-")
  try {
    const measured = await measure({
      app,
      sha: env.app.fixed.sha,
      testsDir: join(env.workspace, playwright.testDir),
      baseUrl: app.url,
      outDir,
      timeoutMs: deadline - Date.now(),
      types: config.coverage_signal,
    })
    console.log(config.coverage_signal.map(type => describe(labels[type], measured[type])).join("\n"))
  } finally {
    await rm(outDir, { recursive: true, force: true })
    await instance?.stop()
  }
}

function describe(label: string, coverage: Coverage | null) {
  if (!coverage) return `${label}: not measured`
  const uncovered = coverage.uncovered.map(item => `  ${item}`)
  return [`${label}: ${coverage.pct}% (${coverage.covered} of ${coverage.total})`, ...uncovered].join("\n")
}

async function measure({ app, sha, testsDir, baseUrl, outDir, timeoutMs, types }: Measurement) {
  const measured = types.filter(type => (type === "lines" ? app.browser_dir : app.endpoints) !== undefined)
  for (const type of measured) await mkdir(join(outDir, type), { recursive: true })
  await playwright.run({
    testsDir,
    baseUrl,
    reportFile: join(outDir, "suite-report.json"),
    logFile: join(outDir, "suite.log"),
    timeoutMs,
    collectors: measured.map(type => ({ module: collectors[type], dir: join(outDir, type) })),
  })
  return {
    lines: measured.includes("lines") ? await lineReport(app, sha, baseUrl, join(outDir, "lines")) : null,
    api: measured.includes("api") ? await apiReport(app, baseUrl, join(outDir, "api")) : null,
  }
}

async function lineReport(app: App, sha: string, baseUrl: string, dir: string) {
  const source = await tempDir("atg-source-")
  try {
    await exportVersion(app, sha, source)
    return await monocartReport(app, source, baseUrl, dir)
  } finally {
    await rm(source, { recursive: true, force: true })
  }
}

async function apiReport(app: App, baseUrl: string, dir: string): Promise<Coverage | null> {
  if (app.endpoints === undefined) return null
  const raw = join(dir, rawDir)
  const files = existsSync(raw) ? await readdir(raw) : []
  const requests = await Promise.all(files.map(async file => requestsSchema.parse(await readJson(join(raw, file)))))
  await rm(raw, { recursive: true, force: true })
  const result = matchEndpoints(app.endpoints, new URL(baseUrl).origin, requests.flat())
  const report = join(dir, "report.json")
  await writeJson(report, result)
  return {
    covered: result.covered.length,
    total: result.endpoints.length,
    pct: Math.round((result.covered.length / result.endpoints.length) * 10_000) / 100,
    report,
    uncovered: result.uncovered,
  }
}

export function matchEndpoints(endpoints: string[], origin: string, requests: z.infer<typeof requestsSchema>) {
  const templates = endpoints
    .map(endpoint => ({ endpoint, pattern: new RegExp(`^${endpoint.split(/\{[^}]*\}/).map(RegExp.escape).join("[^/]+")}$`) }))
    .toSorted((a, b) => a.endpoint.split("{").length - b.endpoint.split("{").length)
  const covered = new Set<string>()
  const unmatched = new Set<string>()
  const ignored = new Set<string>()
  for (const { method, url, type, unserved } of requests) {
    const { origin: requestOrigin, pathname } = new URL(url)
    const operation = `${method} ${pathname}`
    const endpoint = templates.find(template => template.pattern.test(operation))?.endpoint
    if (unserved) ignored.add(`${method} ${url} (${unserved})`)
    else if (requestOrigin !== origin) ignored.add(`${method} ${url} (other origin)`)
    else if (endpoint) covered.add(endpoint)
    else if (method === "GET" && pageLoads.includes(type)) ignored.add(`${method} ${url} (${type})`)
    else unmatched.add(operation)
  }
  return {
    endpoints: endpoints.toSorted(),
    covered: [...covered].toSorted(),
    uncovered: endpoints.filter(endpoint => !covered.has(endpoint)).toSorted(),
    unmatched: [...unmatched].toSorted(),
    ignored: [...ignored].toSorted(),
  }
}

async function monocartReport(app: App, source: string, baseUrl: string, dir: string): Promise<Coverage | null> {
  if (app.browser_dir === undefined) return null
  const browserDir = app.browser_dir
  const files = new Set(await readdir(join(source, browserDir), { recursive: true }))
  const ownFile = (url: string) => {
    if (!URL.canParse(url)) return undefined
    const { origin, pathname } = new URL(url)
    const file = decodeURIComponent(pathname.slice(1))
    return origin === new URL(baseUrl).origin && files.has(file) ? posix.join(browserDir, file) : undefined
  }
  const mcr = MCR({
    name: "Browser-side line coverage",
    outputDir: dir,
    baseDir: source,
    logging: "error",
    reports: ["v8"],
    entryFilter: entry => ownFile(entry.url) !== undefined,
    sourcePath: (path, entry) => ownFile(entry.url) ?? path,
    sourceFilter: { "**/node_modules/**": false, "**/*": true },
    all: { dir: join(source, browserDir), filter: { "**/*.{js,mjs}": "js", "**/*.css": "css" } },
  })
  const raw = join(dir, rawDir)
  for (const file of existsSync(raw) ? await readdir(raw) : []) await mcr.add(JSON.parse(await readFile(join(raw, file), "utf8")))
  await rm(raw, { recursive: true, force: true })
  const results = await mcr.generate()
  const lines = results?.summary.lines
  if (!results || typeof lines?.pct !== "number") return null
  const snapshot = MCR.getSnapshot(results)
  return {
    covered: lines.covered,
    total: lines.total,
    pct: lines.pct,
    report: join(dir, "index.html"),
    uncovered: Object.entries(snapshot.files)
      .filter(([, file]) => file.uncoveredLines)
      .map(([path, file]) => `${path}: ${file.lines} of lines covered, uncovered lines ${file.uncoveredLines}`),
  }
}
