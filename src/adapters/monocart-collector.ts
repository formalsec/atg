import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Page } from "@playwright/test"

export const rawDir = "raw"

export async function collect(page: Page, dir: string) {
  await Promise.all([
    page.coverage.startJSCoverage({ resetOnNavigation: false }),
    page.coverage.startCSSCoverage({ resetOnNavigation: false }),
  ])
  return async () => {
    const [js, css] = await Promise.all([page.coverage.stopJSCoverage(), page.coverage.stopCSSCoverage()])
    await mkdir(join(dir, rawDir), { recursive: true })
    await writeFile(join(dir, rawDir, `${randomUUID()}.json`), JSON.stringify([...js, ...css]))
  }
}
