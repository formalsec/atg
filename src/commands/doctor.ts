import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { loadApps } from "../apps.ts"
import { check } from "../check.ts"
import { agents, frameworks } from "../registries.ts"

const exec = promisify(execFile)

export async function doctor() {
  const adapters = [...agents, ...frameworks].flatMap(entry => (entry.adapter ? [entry.adapter] : []))
  const apps = await loadApps()
  const checks = [
    ...(await Promise.all(adapters.map(adapter => adapter.checks()))).flat(),
    ...(await Promise.all(apps.map(app => check(`${app.id} start command`, () => onPath(app.start))))),
  ]
  for (const result of checks) console.log(`${result.ok ? "✔" : "✖"} ${result.name}: ${result.detail}`)
  if (checks.some(result => !result.ok)) process.exitCode = 1
}

async function onPath(command: string) {
  const program = command.trim().split(/\s+/)[0]
  const found = await exec("sh", ["-c", 'command -v "$1"', "sh", program]).catch(() => undefined)
  if (!found) throw new Error(`${program} is not on PATH`)
  return `${program} is ${found.stdout.trim()}`
}
