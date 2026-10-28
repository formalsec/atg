import { randomUUID } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Page, Request } from "@playwright/test"
import { rawDir } from "./coverage-collector.ts"

export function collect(page: Page, dir: string) {
  const context = page.context()
  const pending = new Set<Request>()
  const requests: unknown[] = []
  const seen = (request: Request, unserved?: string) => ({
    method: request.method(),
    url: request.url(),
    type: request.resourceType(),
    unserved,
  })
  context.on("request", request => pending.add(request))
  context.on("response", response => {
    pending.delete(response.request())
    // Playwright gives no server address for a response that page.route fulfilled
    requests.push(response.serverAddr().then(address => seen(response.request(), address === null ? "not served by the app" : undefined)))
  })
  context.on("requestfailed", request => {
    pending.delete(request)
    requests.push(seen(request, `failed: ${request.failure()?.errorText}`))
  })
  return async () => {
    requests.push(...[...pending].map(request => seen(request, "no response before the test ended")))
    await mkdir(join(dir, rawDir), { recursive: true })
    await writeFile(join(dir, rawDir, `${randomUUID()}.json`), JSON.stringify(await Promise.all(requests)))
  }
}
