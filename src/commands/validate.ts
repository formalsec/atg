import * as z from "zod"
import { type App, findApp, loadApps } from "../apps.ts"
import { type Config, configSchema } from "../config.ts"
import { readJson } from "../json.ts"
import { runId } from "../run-id.ts"

type Result =
  | { file: string; valid: true; run_id: string; config: Config }
  | { file: string; valid: false; error: string }

export async function validate(files: string[], options: { json?: boolean }) {
  const apps = await loadApps()
  const results = await Promise.all(files.map(file => check(file, apps)))
  if (options.json) console.log(JSON.stringify(results, null, 2))
  else results.forEach(print)
  if (results.some(result => !result.valid)) process.exitCode = 1
}

async function check(file: string, apps: App[]): Promise<Result> {
  try {
    const result = configSchema(apps).safeParse(await readJson(file))
    if (!result.success) return { file, valid: false, error: z.prettifyError(result.error) }
    return { file, valid: true, run_id: runId(result.data, findApp(apps, result.data.app)), config: result.data }
  } catch (error) {
    return { file, valid: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function print(result: Result) {
  if (result.valid) console.log(`✔ ${result.file}\nrun_id ${result.run_id}\n${JSON.stringify(result.config, null, 2)}`)
  else console.error(`✖ ${result.file}\n${result.error}`)
}
