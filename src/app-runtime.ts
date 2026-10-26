import { readFile, rm } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import type { App } from "./apps.ts"
import { type Exit, launch } from "./process.ts"
import { exportVersion } from "./repo.ts"
import { tempDir } from "./temp.ts"

const startLimitMs = 120_000

export async function startApp(app: App, sha: string, logFile: string) {
  const { url, start } = app
  if (url === undefined) throw new Error(`app "${app.id}" has no url to test against`)
  if (start === undefined) {
    if (!(await answers(url))) throw new Error(`app "${app.id}" has no start command and ${url} does not answer`)
    return { url, stop: async () => {} }
  }
  if (await answers(url)) throw new Error(`${url} answers before the app started; stop whatever holds it`)
  const dir = await tempDir("atg-app-")
  const removeDir = () => rm(dir, { recursive: true, force: true })
  await exportVersion(app, sha, dir).catch(async error => {
    await removeDir()
    throw error
  })
  const proc = launch("sh", ["-c", start], { cwd: dir, env: process.env, stdout: logFile, stderr: logFile })
  const stop = async () => {
    proc.kill()
    await removeDir()
  }
  try {
    await waitUntilAnswers(url, proc.exit)
  } catch (error) {
    await stop()
    const log = await readFile(logFile, "utf8").catch(() => "")
    throw new Error(`app "${app.id}" did not start: ${error instanceof Error ? error.message : error}\n${log.slice(-2000)}`)
  }
  return { url, stop }
}

async function waitUntilAnswers(url: string, exit: Promise<Exit>) {
  let exited: Exit | undefined
  void exit.then(result => (exited = result))
  const giveUpAt = Date.now() + startLimitMs
  while (!(await answers(url))) {
    if (exited) throw new Error(`the start command exited with code ${exited.code} before ${url} answered`)
    if (Date.now() > giveUpAt) throw new Error(`${url} did not answer within ${startLimitMs / 1000}s`)
    await sleep(200)
  }
}

async function answers(url: string) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
    await response.body?.cancel()
    return true
  } catch {
    return false
  }
}
