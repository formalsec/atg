import { createHash } from "node:crypto"
import type { App } from "./apps.ts"
import type { Config } from "./config.ts"

export function runId(config: Config, app: Pick<App, "fixed_ref" | "buggy_ref">) {
  const content = JSON.stringify({ config, fixed_ref: app.fixed_ref, buggy_ref: app.buggy_ref })
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 8)
  return [config.app, config.agent.name, config.framework, hash].join("__")
}
