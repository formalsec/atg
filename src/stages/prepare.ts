import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { arch, homedir, release, tmpdir, type } from "node:os"
import { basename, isAbsolute, join, relative } from "node:path"
import { promisify } from "node:util"
import { type App, appDir, type Input } from "../apps.ts"
import type { Config } from "../config.ts"
import { writeJson } from "../json.ts"
import { promptTemplate, renderPrompt } from "../prompt.ts"
import { frameworkEntry } from "../registries.ts"
import { exportVersion, type Versions } from "../repo.ts"
import { mergeEnv, runFiles } from "../run-folder.ts"

const exec = promisify(execFile)
const atgRoot = join(import.meta.dirname, "..", "..")

export async function prepare(runDir: string, config: Config, app: App, versions: Versions) {
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
  const framework = frameworkEntry(config.framework)
  const url = config.inputs.includes("url") ? app.url : undefined
  await framework.adapter.scaffold(workspace, url)
  for (const input of config.inputs) await copyInput(input, app, versions.fixed, workspace)
  const prompt = renderPrompt(promptTemplate, config.inputs, {
    framework: framework.label,
    test_dir: framework.adapter.testDir,
    test_command: framework.adapter.testCommand,
    ...(url === undefined ? {} : { url }),
    ...(config.inputs.includes("task") && app.stories_file ? { task_file: basename(app.stories_file) } : {}),
  })
  await writeFile(join(runDir, runFiles.prompt), prompt)
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
