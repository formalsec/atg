import { writeFile } from "node:fs/promises"
import * as z from "zod"
import { loadApps } from "../apps.ts"
import { configSchema } from "../config.ts"

export async function schema(options: { out?: string }) {
  const jsonSchema = z.toJSONSchema(configSchema(await loadApps()), { io: "input" })
  const text = `${JSON.stringify(jsonSchema, null, 2)}\n`
  if (options.out) await writeFile(options.out, text)
  else process.stdout.write(text)
}
