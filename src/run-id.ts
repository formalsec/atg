import { createHash } from "node:crypto"
import type { App } from "./apps.ts"
import type { Config } from "./config.ts"
import { promptTemplate } from "./prompt.ts"
import { resolveVersions, type Versions } from "./repo.ts"

export function runId(config: Config, versions: Versions, template: string) {
  const content = JSON.stringify({ config, versions, template })
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 8)
  return [config.app, config.agent.name, config.framework, hash].join("__")
}

export async function identify(config: Config, app: App) {
  const versions = await resolveVersions(app)
  return { id: runId(config, versions, promptTemplate), versions }
}
