import { loadApps, providedInputs } from "../apps.ts"

export async function listApps(options: { json?: boolean }) {
  const apps = (await loadApps()).map(app => ({ ...app, inputs: providedInputs(app) }))
  if (options.json) return console.log(JSON.stringify(apps, null, 2))
  const width = Math.max("APP".length, ...apps.map(app => app.id.length))
  console.log(`${"APP".padEnd(width)}  INPUTS`)
  for (const app of apps) console.log(`${app.id.padEnd(width)}  ${app.inputs.join(", ") || "(none)"}`)
}
