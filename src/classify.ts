import type { SuiteResult } from "./registries.ts"

type Status = SuiteResult["tests"][number]["status"]
type Repetition = { key: string; status: Status }[]

export const fixedVerdicts = ["stable_pass", "broken", "flaky", "skipped"] as const
export const buggyVerdicts = ["revealing", "flaky_on_buggy", "not_revealing"] as const

export type Verdict = {
  key: string
  fixed: (typeof fixedVerdicts)[number]
  buggy?: (typeof buggyVerdicts)[number]
}

export type Classification = { tests: Verdict[]; duplicates: string[] }

export function classify(fixed: Repetition[], buggy: Repetition[]): Classification {
  const duplicates = [...new Set(fixed.flatMap(repeatedKeys))]
  const keys = [...new Set(fixed.flat().map(test => test.key))].filter(key => !duplicates.includes(key))
  const tests = keys.map((key): Verdict => {
    const verdict = fixedVerdict(statuses(fixed, key))
    if (verdict !== "stable_pass" || buggy.length === 0) return { key, fixed: verdict }
    return { key, fixed: verdict, buggy: buggyVerdict(statuses(buggy, key)) }
  })
  return { tests, duplicates }
}

export function caught(tests: Verdict[]) {
  return tests.some(test => test.buggy === "revealing")
}

export function caughtStrict({ tests, duplicates }: Classification) {
  return duplicates.length === 0 && tests.every(test => test.fixed === "stable_pass") && caught(tests)
}

function repeatedKeys(repetition: Repetition) {
  const keys = repetition.map(test => test.key)
  return keys.filter((key, index) => keys.indexOf(key) !== index)
}

function statuses(repetitions: Repetition[], key: string) {
  return repetitions.map(repetition => repetition.find(test => test.key === key)?.status ?? "failed")
}

function failed(status: Status) {
  return status !== "passed" && status !== "skipped"
}

function fixedVerdict(statuses: Status[]) {
  if (statuses.every(status => status === "passed")) return "stable_pass"
  if (statuses.every(status => status === "skipped")) return "skipped"
  if (statuses.every(failed)) return "broken"
  return "flaky"
}

function buggyVerdict(statuses: Status[]) {
  if (statuses.every(failed)) return "revealing"
  if (!statuses.some(failed)) return "not_revealing"
  return "flaky_on_buggy"
}
