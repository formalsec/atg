import { type CANCEL_SYMBOL, cancel, intro, isCancel, multiselect, outro, select, text } from "@clack/prompts"
import { writeFile } from "node:fs/promises"
import * as z from "zod"
import { findApp, type Input, inputs, loadApps, providedInputs } from "../apps.ts"
import { configSchema, defaults } from "../config.ts"
import { readJson } from "../json.ts"
import { agents, coverageTools, type Descriptor, frameworks } from "../registries.ts"
import { identify } from "../run-id.ts"

const inputLabels: Record<Input, string> = {
  url: "URL of the running app",
  task: "Task: the app's user stories",
  examples: "Example tests",
  code: "Source code",
}

export async function newConfig(options: { out?: string; from?: string }) {
  const apps = await loadApps()
  const schema = configSchema(apps)
  const from = options.from === undefined ? undefined : valid(schema.safeParse(await readJson(options.from)), options.from)

  intro("atg new")
  const appId = answer(
    await select({
      message: "App under test",
      options: apps.map(app => ({ value: app.id, hint: `provides ${providedInputs(app).join(", ") || "nothing"}` })),
      initialValue: from?.app,
    }),
  )
  const app = findApp(apps, appId)
  const provided: readonly Input[] = providedInputs(app)
  const chosenInputs = answer(
    await multiselect({
      message: "Inputs the agent is given (space to toggle, none is fine)",
      options: inputs.map(input => ({
        value: input,
        label: inputLabels[input],
        disabled: !provided.includes(input),
        hint: provided.includes(input) ? undefined : `${app.id} does not provide it`,
      })),
      initialValues: from?.inputs.filter(input => provided.includes(input)),
      required: false,
    }),
  )
  const agent = answer(await select({ message: "Agent", options: choices(agents), initialValue: from?.agent.name }))
  const model = await ask("Model", from?.agent.model, value => (value ? undefined : "model must not be empty"))
  const maxTurns = await ask("Max turns (empty for no limit)", from?.agent.max_turns?.toString(), value =>
    !value || isWholeAboveZero(value) ? undefined : "max_turns must be a whole number above 0, or empty for no limit",
  )
  const maxBudget = await ask("Max budget in USD (empty for no limit)", from?.agent.max_budget_usd?.toString(), value =>
    !value || isAmountAboveZero(value) ? undefined : "max_budget_usd must be a number above 0, or empty for no limit",
  )
  const framework = answer(
    await select({ message: "Test framework", options: choices(frameworks), initialValue: from?.framework }),
  )
  const coverageSignal = answer(
    await multiselect({
      message: "Coverage signal shown to the agent (evaluation always measures all of them)",
      options: choices(coverageTools),
      initialValues: from?.coverage_signal.filter(name => offered(coverageTools).includes(name)),
      required: false,
    }),
  )
  const timeout = await ask("Timeout in minutes", String(from?.timeout_min ?? defaults.timeout_min), value =>
    isWholeAboveZero(value) ? undefined : "timeout_min must be a whole number above 0",
  )
  const rep = await ask("Repetition", String(from?.rep ?? defaults.rep), value =>
    isWholeAboveZero(value) ? undefined : "rep must be a whole number above 0",
  )

  const draft = {
    schema: 1,
    app: app.id,
    inputs: chosenInputs,
    agent: {
      name: agent,
      model,
      max_turns: maxTurns ? Number(maxTurns) : undefined,
      max_budget_usd: maxBudget ? Number(maxBudget) : undefined,
    },
    framework,
    coverage_signal: coverageSignal,
    timeout_min: Number(timeout),
    rep: Number(rep),
  }
  const config = valid(schema.safeParse(draft), "wizard answers")
  const { id } = await identify(config, app)
  const out = options.out ?? `${id}.json`
  await writeFile(out, `${JSON.stringify(config, null, 2)}\n`)
  outro(`Wrote ${out}\nrun_id ${id}`)
}

function offered(registry: Descriptor[]) {
  return registry.filter(entry => entry.implemented).map(entry => entry.name)
}

function choices(registry: Descriptor[]) {
  return registry.map(entry => ({
    value: entry.name,
    label: entry.label,
    disabled: !entry.implemented,
    hint: entry.implemented ? undefined : "not implemented yet",
  }))
}

function answer<T>(value: T | typeof CANCEL_SYMBOL): T {
  if (isCancel(value)) {
    cancel("Cancelled, nothing was written")
    process.exit(130)
  }
  return value
}

async function ask(message: string, fallback: string | undefined, check: (value: string) => string | undefined) {
  return answer(
    await text({
      message,
      placeholder: fallback,
      defaultValue: fallback,
      validate: value => (!value && fallback !== undefined ? undefined : check(value ?? "")),
    }),
  )
}

function isWholeAboveZero(value: string) {
  return /^[1-9]\d*$/.test(value)
}

function isAmountAboveZero(value: string) {
  return Number.isFinite(Number(value)) && Number(value) > 0
}

function valid<T>(result: z.ZodSafeParseResult<T>, source: string) {
  if (!result.success) throw new Error(`${source} is not a valid config\n${z.prettifyError(result.error)}`)
  return result.data
}
