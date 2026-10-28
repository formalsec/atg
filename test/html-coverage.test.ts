import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"
import { htmlReport } from "../src/coverage.ts"
import * as playwright from "../src/playwright.ts"

const pages: Record<string, string> = {
  "/": `<!doctype html><title>Todos</title>
<input id="new-todo" placeholder="What needs to be done?">
<ul id="todos"></ul>
<button id="clear"><span>Clear</span></button>
<a href="/help?from=todos#top">Help</a>
<button disabled>Never</button>
<script>
const input = document.querySelector("#new-todo")
input.addEventListener("keydown", event => {
  if (event.key !== "Enter") return
  const item = document.createElement("li")
  item.innerHTML = \`<label><input type="checkbox"> \${input.value}</label> <button>Delete</button>\`
  item.querySelector("button").addEventListener("click", () => item.remove())
  input.value = ""
  setTimeout(() => document.querySelector("#todos").append(item), 100)
})
</script>`,
  "/help": `<!doctype html><title>Help</title><button>Show answer</button><a href="/">Open todos</a>`,
}

const server = createServer((request, response) => {
  const page = pages[new URL(request.url ?? "/", "http://localhost").pathname]
  response.writeHead(page ? 200 : 404, { "content-type": "text/html" }).end(page ?? "not found")
})
await once(server.listen(0), "listening")
const address = server.address()
if (address === null || typeof address === "string") throw new Error("the test server has no port")
const baseUrl = `http://localhost:${address.port}`
const dir = await mkdtemp(join(tmpdir(), "atg-html-"))
after(async () => {
  server.close()
  await rm(dir, { recursive: true, force: true })
})

const header = `import { expect, test } from "@playwright/test"\n`

const styles = {
  role: `
test("by role", async ({ page }) => {
  await page.goto("/")
  for (const title of ["Buy milk", "Walk the dog"]) {
    await page.getByRole("textbox", { name: "What needs to be done?" }).fill(title)
    await page.keyboard.press("Enter")
  }
  await page.getByRole("checkbox", { name: "Walk the dog" }).check()
  await page.getByRole("button", { name: "Clear" }).click()
  await page.getByRole("button", { name: "Delete" }).first().click()
})`,
  css: `
test("by css", async ({ page }) => {
  await page.goto("/")
  await page.fill("#new-todo", "Pay rent")
  await page.locator("#new-todo").press("Enter")
  await page.locator("li input").check()
  await page.click("#clear")
  await page.locator("li button").click()
})`,
  text: `
test("by placeholder and text", async ({ page }) => {
  await page.goto("/")
  await page.getByPlaceholder("What needs to be done?").fill("Call mom")
  await page.keyboard.press("Enter")
  await page.getByText("Call mom").click()
  await page.getByText("Clear").click()
  await page.getByText("Delete").click()
})`,
}

const edgeCases = {
  tracing: `
test("starts its own tracing", async ({ page, context }) => {
  await context.tracing.start({ snapshots: true })
  await page.goto("/")
  await page.getByRole("link", { name: "Help" }).click()
  await expect(page.getByRole("button", { name: "Show answer" })).toBeVisible()
  await context.tracing.stop()
})`,
  secondPage: `
test("opens a second page", async ({ page }) => {
  const other = await page.context().newPage()
  await other.goto("/help")
  await other.getByRole("link", { name: "Open todos" }).click()
  await expect(other.getByRole("button", { name: "Clear" })).toBeVisible()
})`,
  failed: `
test("fails an action", async ({ page }) => {
  await page.goto("/")
  await page.getByRole("button", { name: "Never" }).click({ timeout: 300 })
})`,
  closed: `
test("closes its page", async ({ page }) => {
  await page.goto("/help")
  await page.getByRole("button", { name: "Show answer" }).click()
  await page.close()
})`,
}

async function measureHtml(name: string, tests: string[]) {
  const runDir = join(dir, name)
  await mkdir(join(runDir, "tests"), { recursive: true })
  await writeFile(join(runDir, "tests", "app.spec.ts"), header + tests.join("\n"))
  const suite = await playwright.run({
    testsDir: join(runDir, "tests"),
    baseUrl,
    reportFile: join(runDir, "suite-report.json"),
    logFile: join(runDir, "suite.log"),
    timeoutMs: 60_000,
    collectors: [
      { module: join(import.meta.dirname, "..", "src", "coverage-collector.ts"), dir: join(runDir, "lines") },
      { module: join(import.meta.dirname, "..", "src", "html-collector.ts"), dir: join(runDir, "html") },
    ],
  })
  const coverage = await htmlReport(baseUrl, join(runDir, "html"))
  return { suite, coverage, report: JSON.parse(await readFile(coverage.report, "utf8")) }
}

const todos = {
  covered: 4,
  total: 6,
  covered_elements: ['button "Clear"', "listitem › button 1", "listitem › checkbox 1", 'textbox "What needs to be done?"'],
  uncovered: ['button "Never"', 'link "Help"'],
}

describe("html element coverage", () => {
  test("gives the same element for a role, css, placeholder or text locator, and one element for all rows of a list", async () => {
    const reports = await Promise.all(Object.entries(styles).map(([name, style]) => measureHtml(name, [style])))
    for (const { suite, report } of reports) {
      assert.deepEqual(suite.tests.map(test => test.status), ["passed"])
      assert.deepEqual(report.routes, { "/": todos })
      assert.deepEqual(report.ignored, [])
    }
  })

  test("counts an element only when an action on it succeeds, keeps every test's actions, and gives the same report in any test order", async () => {
    const tests = [...Object.values(styles), ...Object.values(edgeCases)]
    const [forward, reversed] = await Promise.all([measureHtml("forward", tests), measureHtml("reversed", tests.toReversed())])
    assert.deepEqual(forward.report, reversed.report)
    assert.deepEqual(forward.coverage, { ...reversed.coverage, report: forward.coverage.report })
    const failures = Object.fromEntries(forward.suite.tests.filter(test => test.status !== "passed").map(test => [test.key, test.error]))
    assert.deepEqual(Object.keys(failures).toSorted(), ["app.spec.ts › closes its page", "app.spec.ts › fails an action"])
    assert.match(failures["app.spec.ts › fails an action"] ?? "", /Timeout 300ms exceeded/)
    assert.deepEqual(forward.report.routes, {
      "/": { ...todos, covered: 5, covered_elements: [...todos.covered_elements, 'link "Help"'].toSorted(), uncovered: ['button "Never"'] },
      "/help": { covered: 2, total: 2, covered_elements: ['button "Show answer"', 'link "Open todos"'], uncovered: [] },
    })
    assert.deepEqual(forward.report.ignored, [])
    assert.deepEqual(forward.coverage.uncovered, ['/ button "Never"'])
    assert.equal(forward.coverage.pct, 87.5)
  })
})
