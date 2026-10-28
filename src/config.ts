import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import * as z from "zod"
import type { Versions } from "./app.ts"
import { readJson } from "./run-folder.ts"

const inputs = ["url", "task", "examples", "code"] as const
export type Input = (typeof inputs)[number]

const kebabCase = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "use lowercase kebab-case")

export const appSchema = z.strictObject({
  id: kebabCase,
  repo: z.string().min(1),
  url: z.url(),
  start: z.string().min(1),
  code_dir: z.string().min(1).optional(),
  browser_dir: z.string().min(1).optional(),
  stories_file: z.string().min(1).optional(),
  examples_dir: z.string().min(1).optional(),
  fixed_ref: z.string().min(1),
  buggy_ref: z.string().min(1),
  bugs: z
    .array(z.strictObject({ id: kebabCase, ref: z.string().min(1), description: z.string().min(1) }))
    .min(1)
    .refine(bugs => new Set(bugs.map(bug => bug.id)).size === bugs.length, "bug ids must be unique")
    .optional(),
})

export type App = z.infer<typeof appSchema>

const inputSource = {
  url: "url",
  task: "stories_file",
  examples: "examples_dir",
  code: "code_dir",
} satisfies Record<Input, keyof App>

function providedInputs(app: App) {
  return inputs.filter(input => app[inputSource[input]] !== undefined)
}

export function findApp(apps: App[], id: string) {
  const app = apps.find(app => app.id === id)
  if (!app) throw new Error(`unknown app "${id}"`)
  return app
}

export const appsDir = resolve(process.env.ATG_APPS_DIR ?? join(import.meta.dirname, "..", "apps"))

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

function subset<const T extends readonly string[]>(values: T) {
  return z
    .array(z.enum(values))
    .refine(items => new Set(items).size === items.length, "must not repeat an item")
    .overwrite(items => items.toSorted())
}

export function configSchema(apps: App[]) {
  return z
    .strictObject({
      schema: z.literal(1),
      app: z.enum(apps.map(app => app.id)),
      inputs: subset(inputs),
      agent: z.strictObject({
        name: z.literal("claude"),
        model: z.string().min(1),
        max_turns: z.int().positive().optional(),
        max_budget_usd: z.number().positive().optional(),
      }),
      framework: z.literal("playwright"),
      coverage_signal: subset(["lines"]),
      timeout_min: z.number().positive().default(30),
      rep: z.int().positive().default(1),
    })
    .superRefine((config, ctx) => {
      const provided = providedInputs(findApp(apps, config.app))
      for (const input of config.inputs.filter(input => !provided.includes(input))) {
        ctx.addIssue({
          code: "custom",
          path: ["inputs"],
          message: `app "${config.app}" does not provide "${input}" (it provides: ${provided.join(", ") || "nothing"})`,
        })
      }
    })
}

export type Config = z.output<ReturnType<typeof configSchema>>

export function parseConfig(apps: App[], data: unknown, source: string) {
  const result = configSchema(apps).safeParse(data)
  if (!result.success) throw new Error(`${source} is not a valid config\n${z.prettifyError(result.error)}`)
  return result.data
}

export function runId(config: Config, versions: Versions, template: string) {
  const content = JSON.stringify({ config, versions, template })
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 8)
  return [config.app, config.agent.name, config.framework, hash].join("__")
}
