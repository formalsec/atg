import { execFileSync, spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"

export type Exit = { code: number | null; error?: string }

type Options = { cwd: string; env: NodeJS.ProcessEnv; input?: string; stdout: string; stderr: string }

const live = new Set<number>()

const passedEnv = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM"]

export function cleanEnv(extra: string[] = []) {
  const env: Record<string, string> = {}
  for (const name of [...passedEnv, ...extra]) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

export function launch(command: string, args: string[], options: Options) {
  const stdout = openSync(options.stdout, "a")
  const stderr = options.stderr === options.stdout ? stdout : openSync(options.stderr, "a")
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ["pipe", stdout, stderr],
  })
  closeSync(stdout)
  if (stderr !== stdout) closeSync(stderr)
  child.stdin?.on("error", () => {})
  child.stdin?.end(options.input)
  const pid = child.pid
  let exited = false
  if (pid !== undefined) live.add(pid)
  const kill = () => {
    if (pid === undefined) return
    if (exited) signal(-pid, "SIGKILL")
    else killTree(pid)
    live.delete(pid)
  }
  const exit = new Promise<Exit>(resolve => {
    child.once("error", error => resolve({ code: null, error: error.message }))
    child.once("exit", code => resolve({ code }))
  })
  void exit.then(() => {
    exited = true
    kill()
  })
  return { exit, kill }
}

export async function runWithTimeout(command: string, args: string[], options: Options & { timeoutMs: number }) {
  const proc = launch(command, args, options)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
  }, Math.max(0, options.timeoutMs))
  const exit = await proc.exit
  clearTimeout(timer)
  return { ...exit, timedOut }
}

export function killAll() {
  for (const pid of live) killTree(pid)
  live.clear()
}

function killTree(root: number) {
  const stopped = new Set<number>()
  for (let found = [root]; found.length > 0; found = descendants(root).filter(pid => !stopped.has(pid))) {
    for (const pid of found) {
      signal(pid, "SIGSTOP")
      stopped.add(pid)
    }
  }
  signal(-root, "SIGKILL")
  for (const pid of stopped) signal(pid, "SIGKILL")
}

function descendants(root: number) {
  const children = new Map<number, number[]>()
  for (const row of execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")) {
    const [pid, ppid] = row.trim().split(/\s+/).map(Number)
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  const found = [root]
  for (let index = 0; index < found.length; index++) found.push(...(children.get(found[index]) ?? []))
  return found.slice(1)
}

function signal(pid: number, name: NodeJS.Signals) {
  try {
    process.kill(pid, name)
  } catch {}
}

export function quote(text: string) {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`
}
