import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import * as z from "zod"
import { cleanEnv, runWithTimeout } from "./process.ts"
import { tempDir } from "./run-folder.ts"

const exec = promisify(execFile)
const require = createRequire(import.meta.url)
const packages = ["@playwright/test", "playwright", "playwright-core"]
const killGraceMs = 60_000

export const testDir = "tests"
export const testCommand = "npx playwright test"

let chromium: Promise<string> | undefined

export const suiteResultSchema = z.object({
  tests: z.array(
    z.object({
      key: z.string(),
      status: z.enum(["passed", "failed", "flaky", "skipped"]),
      duration_ms: z.number(),
      error: z.string().optional(),
    }),
  ),
  errors: z.array(z.string()),
})

export type SuiteResult = z.infer<typeof suiteResultSchema>

type SuiteRun = {
  testsDir: string
  baseUrl: string
  reportFile: string
  logFile: string
  timeoutMs: number
  collectors: { module: string; dir: string }[]
}

const testSchema = z.object({
  status: z.enum(["expected", "unexpected", "flaky", "skipped"]),
  results: z.array(z.object({ duration: z.number(), error: z.object({ message: z.string().default("") }).optional() })),
})

const specSchema = z.object({ title: z.string(), file: z.string(), tests: z.array(testSchema) })

const suiteSchema = z.object({
  title: z.string(),
  specs: z.array(specSchema).default([]),
  get suites() {
    return z.array(suiteSchema).default([])
  },
})

type Suite = z.infer<typeof suiteSchema>

const reportSchema = z.object({
  suites: z.array(suiteSchema).default([]),
  errors: z.array(z.object({ message: z.string().default("") })).default([]),
})

const statuses: Record<z.infer<typeof testSchema>["status"], SuiteResult["tests"][number]["status"]> = {
  expected: "passed",
  unexpected: "failed",
  flaky: "flaky",
  skipped: "skipped",
}

export function scaffold(dir: string, baseUrl?: string) {
  return project(dir, agentConfig(baseUrl))
}

export async function run({ testsDir, baseUrl, reportFile, logFile, timeoutMs, collectors }: SuiteRun) {
  const dir = await tempDir("atg-suite-")
  try {
    await project(dir, suiteConfig(reportFile, timeoutMs))
    await writeFile(join(dir, "node_modules", "@playwright", "test", "index.js"), fixture)
    await writeFile(join(dir, "node_modules", "@playwright", "test", "index.mjs"), fixtureModule)
    if (existsSync(testsDir)) await cp(testsDir, join(dir, testDir), { recursive: true })
    const browser = await browserVersion()
    await rm(reportFile, { force: true })
    await runWithTimeout(process.execPath, [join(dir, "node_modules", "@playwright", "test", "cli.js"), "test"], {
      cwd: dir,
      env: { ...cleanEnv(["PLAYWRIGHT_BROWSERS_PATH"]), BASE_URL: baseUrl, ATG_COLLECTORS: JSON.stringify(collectors) },
      stdout: logFile,
      stderr: logFile,
      timeoutMs: timeoutMs + killGraceMs,
    })
    if (!existsSync(reportFile)) throw new Error(`the suite run wrote no report, see ${logFile}`)
    const report = reportSchema.parse(JSON.parse(await readFile(reportFile, "utf8")))
    return {
      tests: report.suites.flatMap(file => collect(file, [file.title])),
      errors: report.errors.map(error => plain(error.message)),
      versions: { "@playwright/test": version(), chromium: browser },
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function project(dir: string, config: string) {
  const modules = join(dir, "node_modules")
  await Promise.all(
    packages.map(name => cp(dirname(require.resolve(`${name}/package.json`)), join(modules, name), { recursive: true })),
  )
  await mkdir(join(modules, ".bin"), { recursive: true })
  await symlink(join("..", "@playwright", "test", "cli.js"), join(modules, ".bin", "playwright"))
  await mkdir(join(dir, testDir), { recursive: true })
  await writeFile(join(dir, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`)
  await writeFile(join(dir, "playwright.config.ts"), config)
}

function agentConfig(baseUrl?: string) {
  return `import { defineConfig } from "@playwright/test"

export default defineConfig({ testDir: "${testDir}", use: { baseURL: ${JSON.stringify(baseUrl)} } })
`
}

function suiteConfig(reportFile: string, timeoutMs: number) {
  return `import { defineConfig } from "@playwright/test"

export default defineConfig({
  testDir: "${testDir}",
  workers: 1,
  retries: 0,
  globalTimeout: ${Math.round(timeoutMs)},
  reporter: [["json", { outputFile: ${JSON.stringify(reportFile)} }]],
  use: { baseURL: process.env.BASE_URL, browserName: "chromium" },
})
`
}

const fixture = `const playwright = require("playwright/test")

const collectors = JSON.parse(process.env.ATG_COLLECTORS)

const test = playwright.test.extend({
  page: async ({ page }, use) => {
    const stops = []
    for (const { module, dir } of collectors) stops.push(await (await import(module)).collect(page, dir))
    await use(page)
    for (const stop of stops) await stop()
  },
})

module.exports = { ...playwright, test, default: test }
`

const fixtureModule = `import atg from "./index.js"

export * from "playwright/test"
export const test = atg.test
export default atg.test
`

function collect(suite: Suite, titles: string[]): SuiteResult["tests"] {
  return [
    ...suite.specs.flatMap(spec =>
      spec.tests.map(test => ({
        key: [...titles, spec.title].join(" › "),
        status: statuses[test.status],
        duration_ms: test.results.reduce((total, result) => total + result.duration, 0),
        error: test.results.flatMap(result => (result.error ? [plain(result.error.message)] : []))[0],
      })),
    ),
    ...suite.suites.flatMap(child => collect(child, [...titles, child.title])),
  ]
}

function plain(text: string) {
  return text.replace(/\u001b\[[0-9;]*m/g, "")
}

function version() {
  return z.object({ version: z.string() }).parse(require("@playwright/test/package.json")).version
}

function browserVersion() {
  const launch = `import { chromium } from "playwright"
const browser = await chromium.launch()
console.log(browser.version())
await browser.close()`
  chromium ??= exec(process.execPath, ["--input-type=module", "-e", launch], { cwd: import.meta.dirname }).then(({ stdout }) =>
    stdout.trim(),
  )
  return chromium
}
