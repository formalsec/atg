import { readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import type { App } from "./apps.ts"
import { type Exit, launch } from "./process.ts"
import { exportVersion } from "./repo.ts"
import { tempDir } from "./temp.ts"

const startLimitMs = 120_000
const stopLimitMs = 30_000

export async function holdUrl(url: string) {
  const file = join(tmpdir(), `atg-url-${new URL(url).host.replaceAll(":", "-")}.lock`)
  let told = false
  for (;;) {
    try {
      await writeFile(file, String(process.pid), { flag: "wx" })
      return () => rm(file, { force: true })
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error
    }
    const holder = await readFile(file, "utf8").catch(() => "")
    if (holder !== "" && !running(Number(holder))) {
      await rm(file, { force: true })
      continue
    }
    if (!told) console.error(`waiting for ${url}: atg process ${holder} uses it`)
    told = true
    await sleep(500)
  }
}

export async function startApp(app: App, sha: string, logFile: string) {
  const { url, start } = app
  if (await answers(url)) throw new Error(`${url} answers before the app started; stop whatever holds it`)
  const dir = await tempDir("atg-app-")
  const removeDir = () => rm(dir, { recursive: true, force: true })
  await exportVersion(app, sha, dir).catch(async error => {
    await removeDir()
    throw error
  })
  const proc = launch("sh", ["-c", start], { cwd: dir, env: process.env, stdout: logFile, stderr: logFile })
  let stopping: Promise<void> | undefined
  const halt = async () => {
    try {
      proc.kill()
      await proc.exit
      await waitUntilSilent(url)
    } finally {
      await removeDir()
    }
  }
  const stop = () => (stopping ??= halt())
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

async function waitUntilSilent(url: string) {
  const giveUpAt = Date.now() + stopLimitMs
  while (await answers(url)) {
    if (Date.now() > giveUpAt) throw new Error(`${url} still answers ${stopLimitMs / 1000}s after the app was stopped`)
    await sleep(100)
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

function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
