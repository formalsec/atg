import { rmSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dirs = new Set<string>()

export async function tempDir(prefix: string) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.add(dir)
  return dir
}

export function removeTempDirs() {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.clear()
}
