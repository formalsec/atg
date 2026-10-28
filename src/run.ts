import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { arch, homedir, release, tmpdir, type } from "node:os"
import { basename, isAbsolute, join, relative, resolve } from "node:path"
import { StringDecoder } from "node:string_decoder"
import { promisify } from "node:util"
import { exportVersion, holdUrl, resolveVersions, startApp, type Versions } from "./app.ts"
import * as claude from "./claude.ts"
import { type App, appDir, type Config, findApp, type Input, loadApps, parseConfig, runId } from "./config.ts"
import { installSignal, signalCommand } from "./coverage.ts"
import { evaluationStages, finalize, printMetrics, runEvaluation } from "./evaluate.ts"
import * as playwright from "./playwright.ts"
import { cleanEnv, quote, runWithTimeout } from "./process.ts"
import { mergeEnv, readJson, readRun, removeWorkspace, runFiles, runStage, stopOnSignals, writeJson } from "./run-folder.ts"

const exec = promisify(execFile)
const atgRoot = join(import.meta.dirname, "..")

const promptTemplate = await readFile(new URL("prompt.md", import.meta.url), "utf8")

type Options = { dryRun?: boolean; force?: boolean; runsDir: string; keepWorkspace?: boolean; reruns: number }

export async function run(file: string, options: Options) {
  const apps = await loadApps()
  const config = parseConfig(apps, await readJson(file), file)
  const app = findApp(apps, config.app)
  const { id, versions } = await identify(config, app)
  const runDir = resolve(options.runsDir, id)
  if (existsSync(join(runDir, runFiles.metrics)) && !options.force) {
    console.log(`run_id ${id} is done, nothing to do (--force redoes it)\n${runDir}`)
    return
  }
  console.error(`atg run ${id}`)
  const release = options.dryRun ? async () => {} : await holdUrl(app.url)
  await rm(runDir, { recursive: true, force: true })
  await mkdir(runDir, { recursive: true })
  stopOnSignals(runDir, options.keepWorkspace)

  const prepareError = await runStage(runDir, "prepare", () => prepare(runDir, config, app, versions))
  if (options.dryRun) {
    if (prepareError) throw new Error(`prepare failed: ${prepareError}`)
    const invocation = await agentInvocation(runDir)
    const promptFile = join(runDir, runFiles.prompt)
    console.log(`run_id ${id} (dry run, the agent was not called)`)
    console.log(`run folder ${runDir}\nworkspace ${invocation.cwd}\nprompt ${promptFile}\nisolation ${invocation.isolation}`)
    console.log(`invocation\n${commandLine(invocation, promptFile)}`)
    return
  }
  try {
    const generated = !prepareError && (await runStage(runDir, "generate", () => generate(runDir))) === undefined
    if (generated) await runEvaluation(runDir, Object.keys(evaluationStages), options.reruns)
  } finally {
    await release()
    if (!options.keepWorkspace) removeWorkspace(runDir)
  }
  const metrics = await finalize(runDir)
  printMetrics(id, runDir, metrics)
  if (metrics.status === "infra_error") process.exitCode = 1
}

export async function identify(config: Config, app: App) {
  const versions = await resolveVersions(app)
  return { id: runId(config, versions, promptTemplate), versions }
}

async function prepare(runDir: string, config: Config, app: App, versions: Versions) {
  const workspace = await isolatedWorkspace()
  await writeJson(join(runDir, runFiles.config), config)
  await mergeEnv(runDir, {
    started_at: new Date().toISOString(),
    atg: await atgVersion(),
    node: process.version,
    os: `${type()} ${release()} ${arch()}`,
    app: {
      id: app.id,
      repo: app.repo,
      fixed: { ref: app.fixed_ref, sha: versions.fixed },
      buggy: { ref: app.buggy_ref, sha: versions.buggy },
    },
    prompt_template_sha256: createHash("sha256").update(promptTemplate).digest("hex"),
    workspace,
  })
  const url = config.inputs.includes("url") ? app.url : undefined
  await playwright.scaffold(workspace, url)
  for (const input of config.inputs) await copyInput(input, app, versions.fixed, workspace)
  const signal = config.coverage_signal.length > 0
  if (signal) await installSignal(workspace, runDir)
  const tags = [...(config.inputs.length > 0 ? config.inputs : ["none"]), ...(signal ? ["signal"] : [])]
  const prompt = renderPrompt(promptTemplate, tags, {
    framework: "Playwright",
    test_dir: playwright.testDir,
    test_command: playwright.testCommand,
    ...(url === undefined ? {} : { url }),
    ...(config.inputs.includes("task") && app.stories_file ? { task_file: basename(app.stories_file) } : {}),
    ...(signal ? { signal_command: signalCommand } : {}),
  })
  await writeFile(join(runDir, runFiles.prompt), prompt)
}

function renderPrompt(template: string, tags: string[], values: Record<string, string>) {
  return template
    .split("\n")
    .flatMap(line => {
      const tagged = line.match(/^\[(\w+)\] (.*)$/)
      if (!tagged) return [line]
      return tags.includes(tagged[1]) ? [tagged[2]] : []
    })
    .join("\n")
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      if (values[key] === undefined) throw new Error(`the prompt template needs a value for {{${key}}}`)
      return values[key]
    })
}

async function copyInput(input: Input, app: App, fixed: string, workspace: string) {
  const source = (path: string | undefined) => {
    if (path === undefined) throw new Error(`app "${app.id}" does not provide "${input}"`)
    return path
  }
  if (input === "task") {
    const file = source(app.stories_file)
    await cp(join(appDir(app), file), join(workspace, basename(file)))
  }
  if (input === "examples") await cp(join(appDir(app), source(app.examples_dir)), join(workspace, "examples"), { recursive: true })
  if (input === "code") await exportVersion(app, fixed, join(workspace, "code"), source(app.code_dir))
}

async function isolatedWorkspace() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "atg-workspace-")))
  for (const forbidden of [homedir(), atgRoot]) {
    const path = relative(await realpath(forbidden), workspace)
    if (path.startsWith("..") || isAbsolute(path)) continue
    await rm(workspace, { recursive: true, force: true })
    throw new Error(`the workspace ${workspace} is inside ${forbidden}, set TMPDIR to a folder outside it`)
  }
  return workspace
}

async function atgVersion() {
  try {
    const commit = await exec("git", ["-C", atgRoot, "rev-parse", "HEAD"])
    const status = await exec("git", ["-C", atgRoot, "status", "--porcelain"])
    return { commit: commit.stdout.trim(), dirty: status.stdout.trim() !== "" }
  } catch {
    return { commit: null, dirty: null }
  }
}

async function agentInvocation(runDir: string) {
  const { config, env } = await readRun(runDir)
  const prompt = await readFile(join(runDir, runFiles.prompt), "utf8")
  const invocation = claude.invocation(config.agent, [
    playwright.testCommand,
    ...(config.coverage_signal.length > 0 ? [signalCommand] : []),
  ])
  return { ...invocation, env: { ...cleanEnv(), ...invocation.env }, cwd: env.workspace, prompt }
}

export function commandLine(invocation: claude.Invocation & { cwd: string }, promptFile: string) {
  const env = Object.entries(invocation.env).map(([key, value]) => `${key}=${secret(key) ? `"$${key}"` : quote(value)}`)
  const command = [invocation.command, ...invocation.args].map(quote).join(" ")
  return `cd ${quote(invocation.cwd)} && env -i ${env.join(" ")} ${command} < ${quote(promptFile)}`
}

async function generate(runDir: string) {
  const { config, env, app, deadline } = await readRun(runDir)
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
    const stopFollowing = followOutput(stdout, line => showActivity(claude.activity(line), workspaces))
    const exit = await running.finally(stopFollowing)
    const result: claude.AgentResult = exit.timedOut
      ? { status: "timeout", stop_reason: "timeout_min" }
      : claude.parse({ stdout: await readFile(stdout, "utf8"), stderr: await readFile(stderr, "utf8"), ...exit })
    await writeJson(join(runDir, runFiles.agent), result)
    await mergeEnv(runDir, {
      agent: {
        name: config.agent.name,
        cli_version: await claude.version().catch(() => null),
        isolation: invocation.isolation,
        requested_model: config.agent.model,
        resolved_models: result.models ?? [],
        command: commandLine(invocation, join(runDir, runFiles.prompt)),
      },
    })
  } finally {
    await instance.stop()
  }
  const tests = join(env.workspace, playwright.testDir)
  if (existsSync(tests)) await cp(tests, join(runDir, runFiles.tests), { recursive: true })
}

function secret(key: string) {
  return /key|token|secret|password/i.test(key)
}

function showActivity(activity: string | undefined, workspaces: string[]) {
  if (activity === undefined) return
  const short = workspaces.reduce((text, workspace) => text.replaceAll(`${workspace}/`, ""), activity)
  const width = process.stderr.isTTY ? process.stderr.columns - 2 : Infinity
  for (const line of short.split("\n")) console.error(`  ${line.length > width ? `${line.slice(0, width - 1)}…` : line}`)
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
