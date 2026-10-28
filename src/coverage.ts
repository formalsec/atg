import { existsSync, realpathSync } from "node:fs"
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join, posix, relative } from "node:path"
import MCR from "monocart-coverage-reports"
import * as z from "zod"
import { exportVersion, startApp } from "./app.ts"
import { type App, appsDir, type Config } from "./config.ts"
import { rawDir } from "./coverage-collector.ts"
import { actions } from "./html-collector.ts"
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
  html: join(import.meta.dirname, "html-collector.ts"),
}

const labels = { lines: "Browser-side line coverage", api: "API endpoint coverage", html: "HTML element coverage" }

const pageLoads = ["document", "stylesheet", "script", "image", "font", "media", "texttrack", "manifest"]

const requestsSchema = z.array(
  z.object({ method: z.string(), url: z.string(), type: z.string(), unserved: z.string().optional() }),
)

const interactiveRoles = [
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]

const itemRoles = ["listitem", "row"]

const htmlRules = {
  denominator:
    "Elements with an interactive role in the ARIA snapshots (Playwright ariaSnapshotJSON, mode ai) that atg took on the fixed version in this run, before each action and when each test ended. Elements of other origins are left out, and elements inside an iframe count only in the snapshots of that iframe.",
  roles: interactiveRoles,
  collapse:
    "An element is its route (the same-origin path, without query or hash), its role and its accessible name. Inside a list item or table row the name is dropped: the element is the item role, its role and its position among the elements with that role in the item. Thus all rows of a list are one row.",
  actions: `An element is covered when one of these Playwright actions on it succeeds: ${Object.keys(actions).join(", ")}. If the target has no interactive role, the action counts for its nearest interactive ancestor, or else for its only interactive descendant, for example the checkbox in a label. Mouse, keyboard and element handle actions, trial actions and failed actions do not count.`,
}

type AriaNode = { role: string; name: string; ref?: string; children: (string | AriaNode)[] }

const ariaNodeSchema: z.ZodType<AriaNode> = z.object({
  role: z.string(),
  name: z.string().default(""),
  ref: z.string().optional(),
  get children() {
    return z.array(z.union([z.string(), ariaNodeSchema])).default([])
  },
})

const snapshotsSchema = z.array(
  z.object({
    url: z.string(),
    tree: z.array(z.union([z.string(), ariaNodeSchema])).nullable(),
    action: z.string().optional(),
    target: z.string().optional(),
  }),
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
    const { lines, api, html } = await measure({
      app,
      sha: env.app.fixed.sha,
      testsDir: join(runDir, runFiles.tests),
      baseUrl: instance.url,
      outDir,
      timeoutMs: config.timeout_min * 60_000,
      types: ["lines", "api", "html"],
    })
    const inRun = (result: Coverage | null) => result && { ...result, report: relative(runDir, result.report) }
    await writeJson(join(outDir, coverageSummary), { lines: inRun(lines), api: inRun(api), html: inRun(html) })
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
  const measured = types.filter(type => ({ lines: app.browser_dir !== undefined, api: app.endpoints !== undefined, html: true })[type])
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
    html: measured.includes("html") ? await htmlReport(baseUrl, join(outDir, "html")) : null,
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
  const requests = await readRaw(dir, requestsSchema)
  const result = matchEndpoints(app.endpoints, new URL(baseUrl).origin, requests.flat())
  const report = join(dir, "report.json")
  await writeJson(report, result)
  return {
    covered: result.covered.length,
    total: result.endpoints.length,
    pct: percent(result.covered.length, result.endpoints.length),
    report,
    uncovered: result.uncovered,
  }
}

export async function htmlReport(baseUrl: string, dir: string): Promise<Coverage> {
  const snapshots = await readRaw(dir, snapshotsSchema)
  const result = matchElements(new URL(baseUrl).origin, snapshots.flat())
  const report = join(dir, "report.json")
  await writeJson(report, { ...htmlRules, ...result })
  return {
    covered: result.covered,
    total: result.total,
    pct: percent(result.covered, result.total),
    report,
    uncovered: Object.entries(result.routes).flatMap(([route, { uncovered }]) => uncovered.map(element => `${route} ${element}`)),
  }
}

async function readRaw<T extends z.ZodType>(dir: string, schema: T) {
  const raw = join(dir, rawDir)
  const files = existsSync(raw) ? await readdir(raw) : []
  const records = await Promise.all(files.map(async file => schema.parse(await readJson(join(raw, file)))))
  await rm(raw, { recursive: true, force: true })
  return records
}

function percent(covered: number, total: number) {
  return total === 0 ? 0 : Math.round((covered / total) * 10_000) / 100
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

export function matchElements(origin: string, snapshots: z.infer<typeof snapshotsSchema>) {
  const pages = new Map<string, { seen: Set<string>; acted: Set<string> }>()
  const ignored = new Set<string>()
  for (const { url, tree, action, target } of snapshots) {
    const { origin: pageOrigin, pathname: route } = new URL(url)
    if (pageOrigin !== origin) {
      if (action) ignored.add(`${action} on ${url} (other origin)`)
      continue
    }
    const page = pages.get(route) ?? { seen: new Set(), acted: new Set() }
    pages.set(route, page)
    const { elements, refs } = interactiveElements(tree ?? [])
    for (const element of elements) page.seen.add(element)
    if (!action) continue
    const element = target === undefined ? undefined : refs.get(target)
    if (element) page.acted.add(element)
    else if (target === undefined) ignored.add(`${action} on ${route} (Playwright gave no ARIA ref for the target)`)
    else ignored.add(`${action} on ${route} (${refs.has(target) ? "the target has no interactive role" : "the target is not in the page snapshot"})`)
  }
  const routes = [...pages].toSorted(([a], [b]) => a.localeCompare(b)).filter(([, { seen }]) => seen.size > 0)
  return {
    covered: routes.reduce((sum, [, { acted }]) => sum + acted.size, 0),
    total: routes.reduce((sum, [, { seen }]) => sum + seen.size, 0),
    routes: Object.fromEntries(
      routes.map(([route, { seen, acted }]) => [
        route,
        {
          covered: acted.size,
          total: seen.size,
          covered_elements: [...acted].toSorted(),
          uncovered: [...seen].filter(element => !acted.has(element)).toSorted(),
        },
      ]),
    ),
    ignored: [...ignored].toSorted(),
  }
}

type Item = { role: string; positions: Map<string, number> }

function interactiveElements(tree: (string | AriaNode)[]) {
  const elements: string[] = []
  const refs = new Map<string, string | undefined>()
  const visit = (nodes: (string | AriaNode)[], item: Item | undefined, ancestor: string | undefined): string[] =>
    nodes.flatMap(node => {
      if (typeof node === "string" || node.role === "iframe") return []
      const element = interactiveRoles.includes(node.role) ? identify(node, item) : undefined
      if (element) elements.push(element)
      const inner = itemRoles.includes(node.role) ? { role: node.role, positions: new Map() } : item
      const inside = visit(node.children, inner, element ?? ancestor)
      if (node.ref) refs.set(node.ref, element ?? ancestor ?? (new Set(inside).size === 1 ? inside[0] : undefined))
      return element ? [element, ...inside] : inside
    })
  visit(tree, undefined, undefined)
  return { elements, refs }
}

function identify(node: AriaNode, item: Item | undefined) {
  if (!item) return node.name ? `${node.role} ${JSON.stringify(node.name)}` : node.role
  const position = (item.positions.get(node.role) ?? 0) + 1
  item.positions.set(node.role, position)
  return `${item.role} › ${node.role} ${position}`
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
