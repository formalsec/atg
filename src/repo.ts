import { execFile } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { join, posix } from "node:path"
import { promisify } from "node:util"
import { type App, appDir } from "./apps.ts"
import { tempDir } from "./temp.ts"

const exec = promisify(execFile)

export type Versions = { fixed: string; buggy: string }

export function resolveVersions(app: App): Promise<Versions> {
  return withClone(app, async clone => ({
    fixed: await resolveRef(app, clone, app.fixed_ref),
    buggy: await resolveRef(app, clone, app.buggy_ref),
  }))
}

export function resolveRefs(app: App, refs: string[]) {
  return withClone(app, clone => Promise.all(refs.map(ref => resolveRef(app, clone, ref))))
}

export function exportVersion(app: App, sha: string, dest: string, path = ".") {
  const tree = posix.normalize(path) === "." ? sha : `${sha}:${path}`
  return withClone(app, async clone => {
    const archive = join(clone, "export.tar")
    await exec("git", ["-C", clone, "archive", "--format=tar", "--output", archive, tree])
    await mkdir(dest, { recursive: true })
    await exec("tar", ["-xf", archive, "-C", dest])
  })
}

async function resolveRef(app: App, clone: string, ref: string) {
  try {
    const { stdout } = await exec("git", ["-C", clone, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])
    return stdout.trim()
  } catch {
    throw new Error(`app "${app.id}": ref "${ref}" is not a commit in ${app.repo}`)
  }
}

async function withClone<T>(app: App, use: (clone: string) => Promise<T>) {
  const clone = await tempDir("atg-repo-")
  try {
    await exec("git", ["clone", "--quiet", "--bare", "--", app.repo, clone], { cwd: appDir(app) })
    return await use(clone)
  } finally {
    await rm(clone, { recursive: true, force: true })
  }
}
