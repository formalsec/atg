import { readdir } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import * as z from "zod"
import { readJson } from "./json.ts"

export const inputs = ["url", "task", "examples", "code"] as const
export type Input = (typeof inputs)[number]

export const appSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "use lowercase kebab-case"),
    repo: z.string().min(1),
    url: z.url().optional(),
    start: z.string().min(1).optional(),
    code_dir: z.string().min(1).optional(),
    stories_file: z.string().min(1).optional(),
    examples_dir: z.string().min(1).optional(),
    fixed_ref: z.string().min(1),
    buggy_ref: z.string().min(1),
  })
  .refine(app => app.url !== undefined || app.start !== undefined, "needs a url or a start command")

export type App = z.infer<typeof appSchema>

const inputSource = {
  url: "url",
  task: "stories_file",
  examples: "examples_dir",
  code: "code_dir",
} satisfies Record<Input, keyof App>

export function providedInputs(app: App) {
  return inputs.filter(input => app[inputSource[input]] !== undefined)
}

export function findApp(apps: App[], id: string) {
  const app = apps.find(app => app.id === id)
  if (!app) throw new Error(`unknown app "${id}"`)
  return app
}

const appsDir = resolve(process.env.ATG_APPS_DIR ?? join(import.meta.dirname, "..", "apps"))

export function appDir(app: App) {
  return join(appsDir, app.id)
}

export async function loadApps() {
  const entries = await readdir(appsDir, { withFileTypes: true })
  const dirs = entries.filter(entry => entry.isDirectory()).map(entry => join(appsDir, entry.name))
  return Promise.all(dirs.toSorted().map(loadApp))
}

async function loadApp(dir: string) {
  const file = join(dir, "app.json")
  const result = appSchema.safeParse(await readJson(file))
  if (!result.success) throw new Error(`${file}\n${z.prettifyError(result.error)}`)
  if (result.data.id !== basename(dir)) throw new Error(`${file}\nid "${result.data.id}" must match its folder name`)
  return result.data
}
