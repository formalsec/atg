import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as z from "zod"
import { type CoverageAdapter, coverageTools } from "../../src/registries.ts"
import { seenDir } from "./fake-collector.ts"

const fake: CoverageAdapter = {
  collector: join(import.meta.dirname, "fake-collector.ts"),
  async universe({ dir }) {
    await writeFile(join(dir, "universe.json"), JSON.stringify(["/", "/help.html"]))
  },
  async report({ dir }) {
    const universe = z.array(z.string()).parse(JSON.parse(await readFile(join(dir, "universe.json"), "utf8")))
    const files = await readdir(join(dir, seenDir))
    const seen = new Set(await Promise.all(files.map(file => readFile(join(dir, seenDir, file), "utf8"))))
    const covered = universe.filter(page => seen.has(page))
    return {
      covered: covered.length,
      total: universe.length,
      pct: (100 * covered.length) / universe.length,
      report: join(dir, "universe.json"),
      uncovered: universe.filter(page => !seen.has(page)),
    }
  },
}

coverageTools[coverageTools.findIndex(tool => tool.name === "html")] = {
  name: "html",
  label: "Fake pages visited",
  implemented: true,
  adapter: fake,
}
