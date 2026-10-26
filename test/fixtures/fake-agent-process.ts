import { spawn } from "node:child_process"
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

const rest = `
test("counts what is left after a todo is done", async ({ page }) => {
  await page.goto("/")
  for (const title of ["Buy milk", "Walk the dog"]) {
    await page.getByPlaceholder("What needs to be done?").fill(title)
    await page.keyboard.press("Enter")
  }
  await page.getByRole("checkbox").first().check()
  await expect(page.getByText("1 left")).toBeVisible()
})

test("fails on purpose", async ({ page }) => {
  await page.goto("/")
  await expect(page.getByText("7 left")).toBeVisible({ timeout: 500 })
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

if (mode === "slow") {
  console.log(JSON.stringify({ pids: [process.pid] }))
  await sleep(3000)
}

await writeFile("tests/todo.spec.ts", header + addsTodo + rest)
console.log("suite written")
