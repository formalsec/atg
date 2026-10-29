import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { progressLine } from "../src/progress.ts"

describe("progressLine", () => {
  test("fills the bar by the share done and shows the time and the step", () => {
    const line = progressLine({ fraction: 0.5, label: "correct app, run 2 of 3", ms: 83_000, columns: 80 })
    assert.match(line, /^. █{15}░{15} 50% {2}1m 23s {2}correct app, run 2 of 3$/)
  })

  test("cuts the step so the line never wraps", () => {
    const line = progressLine({ fraction: 1, label: "x".repeat(200), ms: 0, columns: 60 })
    assert.equal(line.length, 59)
    assert.match(line, /█{30} 100% {2}0s {2}x+$/)
  })
})
