import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join, sep } from "node:path"
import { test } from "node:test"
import { agents, coverageTools, frameworks } from "../src/registries.ts"

const src = join(import.meta.dirname, "..", "src")

test("core never names an agent, framework or coverage tool outside its registry and adapters", async () => {
  const files = (await readdir(src, { recursive: true })).filter(
    file => file.endsWith(".ts") && file !== "registries.ts" && !file.startsWith(`adapters${sep}`),
  )
  const names = [...agents, ...frameworks, ...coverageTools].map(entry => entry.name)
  for (const file of files) {
    const code = (await readFile(join(src, file), "utf8")).toLowerCase()
    for (const name of names) assert.ok(!code.includes(name), `${file} names "${name}"`)
  }
})
