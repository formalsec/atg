import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { join, posix, resolve } from "node:path"
import { promisify } from "node:util"
import { type App, appDir } from "./apps.ts"
import { tempDir } from "./temp.ts"

const exec = promisify(execFile)

const clones = new Map<string, string>()

export type Versions = { fixed: string; buggy: string }

export async function resolveVersions(app: App): Promise<Versions> {
  const clone = await freshClone(app)
  return { fixed: await resolveRef(app, clone, app.fixed_ref), buggy: await resolveRef(app, clone, app.buggy_ref) }
}

export async function resolveRefs(app: App, refs: string[]) {
  const clone = await freshClone(app)
  return Promise.all(refs.map(ref => resolveRef(app, clone, ref)))
}

export async function exportVersion(app: App, sha: string, dest: string, path = ".") {
  const tree = posix.normalize(path) === "." ? sha : `${sha}:${path}`
  const clone = clones.get(cloneKey(app)) ?? (await freshClone(app))
  const archive = join(clone, `${randomUUID()}.tar`)
  try {
    await exec("git", ["-C", clone, "archive", "--format=tar", "--output", archive, tree])
    await mkdir(dest, { recursive: true })
    await exec("tar", ["-xf", archive, "-C", dest])
  } finally {
    await rm(archive, { force: true })
  }
}

async function resolveRef(app: App, clone: string, ref: string) {
  try {
    const { stdout } = await exec("git", ["-C", clone, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
    return stdout.trim()
  } catch {
    throw new Error(`app "${app.id}": ref "${ref}" is not a commit in ${app.repo}`)
  }
}

async function freshClone(app: App) {
  const clone = await tempDir("atg-repo-")
  await exec("git", ["clone", "--quiet", "--bare", "--", app.repo, clone], { cwd: appDir(app) })
  clones.set(cloneKey(app), clone)
  return clone
}

function cloneKey(app: App) {
  return resolve(appDir(app), app.repo)
}
