import * as z from "zod"
import { type App, findApp, inputs, providedInputs } from "./apps.ts"
import { agents, coverageTools, type Descriptor, frameworks } from "./registries.ts"

export const defaults = { timeout_min: 30, rep: 1 }

const names = (registry: Descriptor[]) => registry.map(entry => entry.name)

function subset<const T extends readonly string[]>(values: T, description: string) {
  return z
    .array(z.enum(values))
    .refine(items => new Set(items).size === items.length, "must not repeat an item")
    .overwrite(items => items.toSorted())
    .meta({ uniqueItems: true, description })
}

export function configSchema(apps: App[]) {
  return z
    .strictObject({
      schema: z.literal(1),
      app: z.enum(apps.map(app => app.id)),
      inputs: subset(inputs, "What the agent is given about the app. The app must provide each one."),
      agent: z.strictObject({
        name: z.enum(names(agents)),
        model: z.string().min(1),
        max_turns: z.int().positive().optional(),
        max_budget_usd: z.number().positive().optional(),
      }),
      framework: z.enum(names(frameworks)),
      coverage_signal: subset(
        names(coverageTools),
        "Coverage the agent is shown as feedback while it works. This is the treatment, not the measurement: evaluation always measures every coverage tool.",
      ),
      timeout_min: z
        .number()
        .positive()
        .default(defaults.timeout_min)
        .meta({ description: "Wall-clock limit in minutes for preparing and generating. Fractions are allowed." }),
      rep: z
        .int()
        .positive()
        .default(defaults.rep)
        .meta({ description: "Repetition index. It is part of the run_id, so each repetition is a separate run." }),
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
      const implemented = coverageTools.filter(tool => tool.implemented).map(tool => tool.name)
      for (const tool of config.coverage_signal.filter(tool => !implemented.includes(tool))) {
        ctx.addIssue({
          code: "custom",
          path: ["coverage_signal"],
          message: `coverage tool "${tool}" is not implemented yet, so it cannot be a signal`,
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
