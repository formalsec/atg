import { execFileSync, spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"

const header = `import { expect, test } from "@playwright/test"
`

const addsTodo = `
test("adds a todo", async ({ page }) => {
  await page.goto("/")
  await page.getByPlaceholder("What needs to be done?").fill("Buy milk")
  await page.keyboard.press("Enter")
  await expect(page.getByText("Buy milk")).toBeVisible()
})
`

const countsLeft = `
test("counts what is left after a todo is done", async ({ page }) => {
  await page.goto("/")
  for (const title of ["Buy milk", "Walk the dog"]) {
    await page.getByPlaceholder("What needs to be done?").fill(title)
    await page.keyboard.press("Enter")
  }
  await page.getByRole("checkbox").first().check()
  await expect(page.getByText("1 left")).toBeVisible({ timeout: 1000 })
})
`

const failsOnPurpose = `
test("fails on purpose", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByText("7 left")).toBeVisible({ timeout: 500 })
})
`

const flaky = `
test("fails on every second run", async ({ page }) => {
  const { existsSync, readFileSync, writeFileSync } = await import("node:fs")
  const counter = ${JSON.stringify(process.env.FLAKY_COUNTER ?? "")}
  const runs = (existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0) + 1
  writeFileSync(counter, String(runs))
  await page.goto("/")
  expect(runs % 2).toBe(1)
})
`

const mode = process.argv[2]
await mkdir("tests", { recursive: true })

if (mode === "hang") {
  await writeFile("tests/todo.spec.ts", header + addsTodo)
  const helper = spawn("sleep", ["300"], { detached: true, stdio: "ignore" })
  console.log(JSON.stringify({ pids: [process.pid, helper.pid] }))
  await sleep(600_000)
}

const suite = header + addsTodo + countsLeft + failsOnPurpose
const anonymous = `${header}${addsTodo}\ntest.describe(() => {${countsLeft}})\n${failsOnPurpose}`
const suites: Record<string, string> = { flaky: anonymous + flaky, broken: header + failsOnPurpose }

if (mode === "signal") {
  await writeFile("tests/todo.spec.ts", suite)
  const answers = await fetch("http://localhost:4173").then(
    () => true,
    () => false,
  )
  console.log(`app answers ${answers}`)
  console.log(execFileSync("./coverage", { encoding: "utf8" }))
}

if (mode === "slow") {
  console.log(JSON.stringify({ pids: [process.pid] }))
  await sleep(3000)
}

await writeFile("tests/todo.spec.ts", suites[mode] ?? suite)
console.log("suite written")
