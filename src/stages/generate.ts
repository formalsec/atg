import { log } from "@clack/prompts"
import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs"
import { cp, readFile } from "node:fs/promises"
import { join } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { startApp } from "../app-runtime.ts"
import { signalCommand } from "../commands/signal.ts"
import { writeJson } from "../json.ts"
import { cleanEnv, quote, runWithTimeout } from "../process.ts"
import { agentEntry, type AgentResult, frameworkEntry, type Invocation } from "../registries.ts"
import { mergeEnv, progress, readRun, runFiles } from "../run-folder.ts"

export async function agentInvocation(runDir: string) {
  const { config, env, deadline } = await readRun(runDir)
  const prompt = await readFile(join(runDir, runFiles.prompt), "utf8")
  const invocation = agentEntry(config.agent.name).adapter.invocation({
    workspace: env.workspace,
    prompt,
    agent: config.agent,
    timeLimitMs: deadline - Date.now(),
    commands: [
      frameworkEntry(config.framework).adapter.testCommand,
      ...(config.coverage_signal.length > 0 ? [signalCommand] : []),
    ],
  })
  return { ...invocation, env: { ...cleanEnv(), ...invocation.env }, cwd: env.workspace, prompt }
}

export function commandLine(invocation: Invocation & { cwd: string }, promptFile: string) {
  const env = Object.entries(invocation.env).map(([key, value]) => `${key}=${secret(key) ? `"$${key}"` : quote(value)}`)
  const command = [invocation.command, ...invocation.args].map(quote).join(" ")
  return `cd ${quote(invocation.cwd)} && env -i ${env.join(" ")} ${command} < ${quote(promptFile)}`
}

export async function generate(runDir: string) {
  const { config, env, app, deadline } = await readRun(runDir)
  const agent = agentEntry(config.agent.name).adapter
  const invocation = await agentInvocation(runDir)
  const instance = await startApp(app, env.app.fixed.sha, join(runDir, "app-generate.log"))
  if (!config.inputs.includes("url")) await instance.stop()
  try {
    const stdout = join(runDir, runFiles.agentStdout)
    const stderr = join(runDir, runFiles.agentStderr)
    const running = runWithTimeout(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env,
      input: invocation.prompt,
      stdout,
      stderr,
      timeoutMs: deadline - Date.now(),
    })
    const workspaces = [env.workspace, realpathSync(env.workspace)]
    const stopFollowing = followOutput(stdout, line => showActivity(agent.activity(line), workspaces))
    const exit = await running.finally(stopFollowing)
    const result: AgentResult = exit.timedOut
      ? { status: "timeout", stop_reason: "timeout_min" }
      : agent.parse({ stdout: await readFile(stdout, "utf8"), stderr: await readFile(stderr, "utf8"), ...exit })
    await writeJson(join(runDir, runFiles.agent), result)
    await mergeEnv(runDir, {
      agent: {
        name: config.agent.name,
        cli_version: await agent.version().catch(() => null),
        isolation: invocation.isolation,
        requested_model: config.agent.model,
        resolved_models: result.models ?? [],
        command: commandLine(invocation, join(runDir, runFiles.prompt)),
      },
    })
  } finally {
    await instance.stop()
  }
  const tests = join(env.workspace, frameworkEntry(config.framework).adapter.testDir)
  if (existsSync(tests)) await cp(tests, join(runDir, runFiles.tests), { recursive: true })
}

function secret(key: string) {
  return /key|token|secret|password/i.test(key)
}

function showActivity(activity: string | undefined, workspaces: string[]) {
  if (activity === undefined) return
  const short = workspaces.reduce((text, workspace) => text.replaceAll(`${workspace}/`, ""), activity)
  const width = progress.output.isTTY ? progress.output.columns - 3 : Infinity
  const fitted = short.split("\n").map(line => (line.length > width ? `${line.slice(0, width - 1)}…` : line))
  log.message(fitted, { ...progress, spacing: 0 })
}

function followOutput(file: string, onLine: (line: string) => void) {
  const decoder = new StringDecoder("utf8")
  let position = 0
  let partial = ""
  const readNew = () => {
    const fd = openSync(file, "r")
    try {
      const chunk = Buffer.alloc(fstatSync(fd).size - position)
      position += readSync(fd, chunk, 0, chunk.length, position)
      const parts = (partial + decoder.write(chunk)).split("\n")
      partial = parts.pop() ?? ""
      for (const line of parts) onLine(line)
    } finally {
      closeSync(fd)
    }
  }
  const timer = setInterval(readNew, 500)
  return () => {
    clearInterval(timer)
    readNew()
  }
}
