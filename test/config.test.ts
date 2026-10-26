import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"
import * as z from "zod"
import { appSchema, findApp, loadApps } from "../src/apps.ts"
import { configSchema } from "../src/config.ts"
import { resolveVersions } from "../src/repo.ts"
import { identify, runId } from "../src/run-id.ts"

const apps = await loadApps()
const schema = configSchema(apps)

const base = {
  schema: 1,
  app: "demo-todo",
  inputs: ["url", "code"],
  agent: { name: "claude", model: "claude-opus-5-5" },
  framework: "playwright",
  coverage_signal: ["lines"],
}

const versions = { fixed: "1".repeat(40), buggy: "2".repeat(40) }

function idOf(data: unknown, shas = versions, template = "template v1") {
  return runId(schema.parse(data), shas, template)
}

function errorOf(data: unknown) {
  const result = schema.safeParse(data)
  if (result.success) assert.fail("expected the config to be rejected")
  return z.prettifyError(result.error)
}

describe("config schema", () => {
  test("accepts empty input and coverage sets", () => {
    assert.ok(schema.safeParse({ ...base, inputs: [], coverage_signal: [] }).success)
  })

  test("rejects unknown keys at any level", () => {
    assert.match(errorOf({ ...base, color: "red" }), /Unrecognized key: "color"/)
    assert.match(errorOf({ ...base, agent: { ...base.agent, turns: 3 } }), /Unrecognized key: "turns"/)
  })

  test("rejects duplicates in subsets", () => {
    assert.match(errorOf({ ...base, inputs: ["url", "url"] }), /must not repeat an item\n {2}→ at inputs/)
    assert.match(errorOf({ ...base, coverage_signal: ["lines", "lines"] }), /must not repeat an item\n {2}→ at coverage_signal/)
  })

  test("rejects a signal tool that is not implemented", () => {
    assert.match(
      errorOf({ ...base, coverage_signal: ["html", "lines"] }),
      /coverage tool "html" is not implemented yet, so it cannot be a signal\n {2}→ at coverage_signal/,
    )
  })

  test("rejects an unknown app", () => {
    assert.match(errorOf({ ...base, app: "nope" }), /expected one of "demo-blog"\|"demo-todo"\n {2}→ at app/)
  })

  test("rejects inputs the app does not provide", () => {
    assert.match(errorOf({ ...base, app: "demo-blog" }), /app "demo-blog" does not provide "code"/)
  })

  test("normalizes defaults and subset order", () => {
    assert.deepEqual(schema.parse({ ...base, inputs: ["url", "code"] }), {
      ...base,
      inputs: ["code", "url"],
      timeout_min: 30,
      rep: 1,
    })
  })
})

describe("app schema", () => {
  test("accepts a bug list with unique kebab-case ids, and rejects others", () => {
    const app = { id: "app", repo: "repo.bundle", url: "http://localhost:4173", fixed_ref: "a", buggy_ref: "b" }
    const bug = { id: "counter", ref: "c", description: "The counter is wrong." }
    const issues = (data: unknown) => appSchema.safeParse(data).error?.issues.map(issue => issue.message) ?? []
    assert.deepEqual(issues({ ...app, bugs: [bug] }), [])
    assert.deepEqual(issues({ ...app, bugs: [{ ...bug, id: "../escape" }] }), ["use lowercase kebab-case"])
    assert.deepEqual(issues({ ...app, bugs: [bug, bug] }), ["bug ids must be unique"])
    assert.deepEqual(issues({ ...app, bugs: [] }), ["Too small: expected array to have >=1 items"])
  })
})

describe("run_id", () => {
  const id = idOf(base)

  test("names app, agent and framework, then a short hash", () => {
    assert.match(id, /^demo-todo__claude__playwright__[0-9a-f]{8}$/)
  })

  test("is the same for equivalent configs", () => {
    const reordered = Object.fromEntries(Object.entries(base).toReversed())
    const variants = [
      reordered,
      { ...base, inputs: ["code", "url"] },
      { ...base, timeout_min: 30, rep: 1 },
    ]
    for (const variant of variants) {
      assert.equal(JSON.stringify(schema.parse(variant)), JSON.stringify(schema.parse(base)))
      assert.equal(idOf(variant), id)
    }
  })

  test("changes when any field changes", () => {
    const changes = [
      { ...base, app: "demo-blog", inputs: ["url"] },
      { ...base, inputs: ["url"] },
      { ...base, agent: { ...base.agent, name: "codex" } },
      { ...base, agent: { ...base.agent, model: "other-model" } },
      { ...base, agent: { ...base.agent, max_turns: 50 } },
      { ...base, agent: { ...base.agent, max_budget_usd: 5 } },
      { ...base, framework: "cypress" },
      { ...base, coverage_signal: [] },
      { ...base, timeout_min: 45 },
      { ...base, rep: 2 },
    ]
    const ids = changes.map(change => idOf(change))
    assert.equal(new Set([id, ...ids]).size, changes.length + 1)
  })

  test("changes when a resolved commit or the prompt template changes", () => {
    assert.notEqual(idOf(base, { ...versions, fixed: "3".repeat(40) }), id)
    assert.notEqual(idOf(base, { ...versions, buggy: "3".repeat(40) }), id)
    assert.notEqual(idOf(base, versions, "template v2"), id)
  })

  test("resolves the demo app refs to the commits in its bundle", async () => {
    assert.deepEqual(await resolveVersions(findApp(apps, "demo-todo")), {
      fixed: "f61478d89c5fb5b07dc13f560690166b2c51b387",
      buggy: "d4e812811cb1f4e053355079d4e241541abadce5",
    })
  })

  test("moving a ref to another commit gives a new run_id", async t => {
    const repo = await mkdtemp(join(tmpdir(), "atg-moving-ref-"))
    t.after(() => rm(repo, { recursive: true, force: true }))
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, "-c", "user.name=atg", "-c", "user.email=atg@example.invalid", ...args])
    git("init", "-q")
    git("commit", "-q", "--allow-empty", "-m", "one")
    git("tag", "fixed")
    git("tag", "buggy")
    const app = { ...findApp(apps, "demo-todo"), repo, fixed_ref: "fixed", buggy_ref: "buggy" }
    const config = schema.parse(base)
    const first = await identify(config, app)
    git("commit", "-q", "--allow-empty", "-m", "two")
    git("tag", "-f", "fixed")
    const second = await identify(config, app)
    assert.notEqual(second.versions.fixed, first.versions.fixed)
    assert.equal(second.versions.buggy, first.versions.buggy)
    assert.notEqual(second.id, first.id)
  })
})
