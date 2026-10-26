import { existsSync } from "node:fs"
import { readdir, readFile, rm } from "node:fs/promises"
import { join, posix } from "node:path"
import MCR from "monocart-coverage-reports"
import type { CoverageAdapter } from "../registries.ts"
import { rawDir } from "./monocart-collector.ts"

export const monocart: CoverageAdapter = {
  collector: join(import.meta.dirname, "monocart-collector.ts"),
  async report({ app, source, baseUrl, dir }) {
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
  },
}
