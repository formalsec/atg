import assert from "node:assert/strict"
import { describe, test } from "node:test"
import * as z from "zod"
import { findApp, loadApps } from "../src/apps.ts"
import { configSchema } from "../src/config.ts"
import { runId } from "../src/run-id.ts"

const apps = await loadApps()
const schema = configSchema(apps)

const base = {
  schema: 1,
  app: "demo-todo",
  inputs: ["url", "code"],
  agent: { name: "claude", model: "claude-opus-5-5" },
  framework: "playwright",
  coverage_signal: ["lines", "api"],
}

function idOf(data: unknown, refs = findApp(apps, "demo-todo")) {
  return runId(schema.parse(data), refs)
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
    assert.match(errorOf({ ...base, coverage_signal: ["api", "api"] }), /must not repeat an item\n {2}→ at coverage_signal/)
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
      coverage_signal: ["api", "lines"],
      timeout_min: 30,
      rep: 1,
    })
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
      { ...base, inputs: ["code", "url"], coverage_signal: ["api", "lines"] },
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

  test("changes when an app ref changes", () => {
    const app = findApp(apps, "demo-todo")
    assert.notEqual(idOf(base, { ...app, fixed_ref: "v9" }), id)
    assert.notEqual(idOf(base, { ...app, buggy_ref: "v9-buggy" }), id)
  })
})
