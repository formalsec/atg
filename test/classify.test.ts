import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { caught, caughtStrict, classify } from "../src/evaluate.ts"

type Status = "passed" | "failed" | "flaky" | "skipped"

const repetitions = (...statuses: (Status | undefined)[]) =>
  statuses.map(status => (status === undefined ? [] : [{ key: "t", status }]))

const verdictOf = (fixed: (Status | undefined)[], buggy: (Status | undefined)[] = []) =>
  classify(repetitions(...fixed), repetitions(...buggy)).tests[0]

describe("classify", () => {
  const fixedCases: [string, (Status | undefined)[], string][] = [
    ["passes every repetition", ["passed", "passed", "passed"], "stable_pass"],
    ["fails every repetition", ["failed", "failed", "failed"], "broken"],
    ["passes some repetitions and fails others", ["passed", "failed", "passed"], "flaky"],
    ["is skipped in every repetition", ["skipped", "skipped", "skipped"], "skipped"],
    ["is skipped in some repetitions and passes in others", ["skipped", "passed", "passed"], "flaky"],
    ["is skipped in some repetitions and fails in others", ["skipped", "failed", "failed"], "flaky"],
    ["is missing from one repetition", ["passed", undefined, "passed"], "flaky"],
    ["passes on retry (framework flaky)", ["flaky", "flaky", "flaky"], "broken"],
    ["passes its only repetition (R=1)", ["passed"], "stable_pass"],
    ["fails its only repetition (R=1)", ["failed"], "broken"],
    ["is skipped in its only repetition (R=1)", ["skipped"], "skipped"],
  ]
  for (const [name, fixed, verdict] of fixedCases) {
    test(`on fixed, a test that ${name} is ${verdict}`, () => {
      assert.equal(verdictOf(fixed, fixed.map((): Status => "failed")).fixed, verdict)
    })
  }

  const buggyCases: [string, (Status | undefined)[], string][] = [
    ["fails every repetition", ["failed", "failed", "failed"], "revealing"],
    ["passes every repetition", ["passed", "passed", "passed"], "not_revealing"],
    ["fails some repetitions", ["failed", "passed", "failed"], "flaky_on_buggy"],
    ["is skipped in every repetition", ["skipped", "skipped", "skipped"], "not_revealing"],
    ["is skipped in some repetitions and fails in others", ["skipped", "failed", "failed"], "flaky_on_buggy"],
    ["fails its only repetition (R=1)", ["failed"], "revealing"],
    ["passes its only repetition (R=1)", ["passed"], "not_revealing"],
  ]
  for (const [name, buggy, verdict] of buggyCases) {
    test(`on buggy, a stable_pass test that ${name} is ${verdict}`, () => {
      const fixed = buggy.map((): Status => "passed")
      assert.deepEqual(verdictOf(fixed, buggy), { key: "t", fixed: "stable_pass", buggy: verdict })
    })
  }

  test("gives a buggy verdict only to stable_pass tests", () => {
    for (const fixed of [["failed", "failed"], ["passed", "failed"], ["skipped", "skipped"]] satisfies Status[][]) {
      assert.equal(verdictOf(fixed, ["failed", "failed"]).buggy, undefined)
    }
  })

  test("gives no buggy verdict when buggy has no repetitions", () => {
    assert.deepEqual(verdictOf(["passed", "passed"]), { key: "t", fixed: "stable_pass" })
  })

  test("leaves tests that share a key out and reports the key", () => {
    const fixed = [
      [
        { key: "a", status: "passed" },
        { key: "a", status: "failed" },
        { key: "b", status: "passed" },
      ],
    ] satisfies { key: string; status: Status }[][]
    const result = classify(fixed, [[{ key: "b", status: "failed" }]])
    assert.deepEqual(result, { tests: [{ key: "b", fixed: "stable_pass", buggy: "revealing" }], duplicates: ["a"] })
  })
})

describe("caught", () => {
  const suite = (fixed: Status[][], buggy: Status[][]) =>
    classify(
      fixed.map(statuses => statuses.map((status, index) => ({ key: `t${index}`, status }))),
      buggy.map(statuses => statuses.map((status, index) => ({ key: `t${index}`, status }))),
    )

  test("is true with one revealing test, and strict only when every test is stable_pass", () => {
    const allStable = suite([["passed", "passed"], ["passed", "passed"]], [["failed", "passed"], ["failed", "passed"]])
    assert.equal(caught(allStable.tests), true)
    assert.equal(caughtStrict(allStable), true)
    const oneBroken = suite([["passed", "failed"], ["passed", "failed"]], [["failed"], ["failed"]])
    assert.equal(caught(oneBroken.tests), true)
    assert.equal(caughtStrict(oneBroken), false)
  })

  test("is false when a test fails on buggy only in some repetitions", () => {
    const result = suite([["passed"], ["passed"]], [["failed"], ["passed"]])
    assert.equal(caught(result.tests), false)
    assert.equal(caughtStrict(result), false)
  })

  test("is false with no stable_pass test, and for an empty suite", () => {
    const broken = suite([["failed"], ["failed"]], [])
    assert.equal(caught(broken.tests), false)
    assert.equal(caughtStrict(broken), false)
    const empty = suite([[], []], [])
    assert.equal(caught(empty.tests), false)
    assert.equal(caughtStrict(empty), false)
  })

  test("strict is false when two tests share a key", () => {
    const result = classify(
      [
        [
          { key: "a", status: "passed" },
          { key: "a", status: "passed" },
          { key: "b", status: "passed" },
        ],
      ],
      [[{ key: "b", status: "failed" }]],
    )
    assert.equal(caught(result.tests), true)
    assert.equal(caughtStrict(result), false)
  })
})
