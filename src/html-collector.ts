import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Frame, Locator, Page } from "@playwright/test"
import * as z from "zod"
import { rawDir } from "./coverage-collector.ts"

export const actions = {
  check: 1,
  click: 1,
  dblclick: 1,
  dragAndDrop: 2,
  fill: 2,
  press: 2,
  selectOption: 2,
  setInputFiles: 2,
  tap: 1,
  type: 2,
  uncheck: 1,
}

const optionsSchema = z.object({ timeout: z.number().optional(), trial: z.boolean().optional() })

const firstNodeSchema = z.tuple([z.object({ ref: z.string().optional() })]).rest(z.unknown())

type Snapshot = { url: string; tree: unknown; action?: string; target?: string }

export function collect(page: Page, dir: string) {
  const frame = Object.getPrototypeOf(page.mainFrame())
  const originals = Object.keys(actions).map(action => [action, frame[action]])
  const snapshots: Snapshot[] = []
  for (const [action, optionsAt] of Object.entries(actions)) {
    const original = frame[action]
    frame[action] = async function (this: Frame, ...args: unknown[]) {
      const options = optionsSchema.safeParse(args[optionsAt]).data
      const target = await refOf(this.locator(String(args[0])).first(), options?.timeout)
      const snapshot: Snapshot = { url: this.url(), tree: await this.locator("body").ariaSnapshotJSON({ mode: "ai" }).catch(() => null) }
      snapshots.push(snapshot)
      const result = await original.apply(this, args)
      if (!options?.trial) Object.assign(snapshot, { action, target })
      return result
    }
  }
  return async () => {
    for (const [action, original] of originals) frame[action] = original
    for (const open of page.context().pages()) {
      snapshots.push({ url: open.url(), tree: await open.ariaSnapshotJSON({ mode: "ai" }).catch(() => null) })
    }
    await mkdir(join(dir, rawDir), { recursive: true })
    await writeFile(join(dir, rawDir, `${randomUUID()}.json`), JSON.stringify(snapshots))
  }
}

async function refOf(target: Locator, timeout: number | undefined): Promise<string | undefined> {
  const snapshot = await target
    .waitFor({ state: "attached", timeout })
    .then(() => target.ariaSnapshotJSON({ mode: "ai" }))
    .catch(() => null)
  const [node] = firstNodeSchema.safeParse(snapshot).data ?? []
  return node && !node.ref ? refOf(target.locator("xpath=.."), timeout) : node?.ref
}
