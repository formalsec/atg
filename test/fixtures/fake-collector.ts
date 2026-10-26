import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Page } from "@playwright/test"

export const seenDir = "seen"

export async function collect(page: Page, dir: string) {
  return async () => {
    await mkdir(join(dir, seenDir), { recursive: true })
    await writeFile(join(dir, seenDir, randomUUID()), new URL(page.url()).pathname)
  }
}
