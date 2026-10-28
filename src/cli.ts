#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from "commander"
import { signal } from "./coverage.ts"
import { defaultReruns, evaluateRun, evaluationStages } from "./evaluate.ts"
import { pilot } from "./pilot.ts"
import { run } from "./run.ts"

const program = new Command("atg").description("Benchmark coding agents that generate E2E test suites")

program
  .command("run")
  .description("Run one config: prepare the workspace, call the agent, evaluate its suite, write metrics")
  .argument("<config>", "config file")
  .option("--dry-run", "prepare the workspace and prompt, print the agent invocation, and stop")
  .option("--force", "redo the run even when it is done")
  .option("--runs-dir <dir>", "folder that holds the run folders", "runs")
  .option("--keep-workspace", "keep the agent workspace after the run")
  .option("--reruns <n>", "times the suite runs on each version, each on a fresh app instance", wholeAboveZero, defaultReruns)
  .action(run)

program
  .command("eval")
  .description("Evaluate a finished run again from its saved tests, without calling the agent, and rewrite metrics.json")
  .argument("<run_id>", "run to evaluate")
  .addOption(new Option("--only <stage>", "run only this evaluation stage").choices(Object.keys(evaluationStages)))
  .option("--reruns <n>", "times the suite runs on each version, each on a fresh app instance", wholeAboveZero, defaultReruns)
  .option("--runs-dir <dir>", "folder that holds the run folders", "runs")
  .action(evaluateRun)

program
  .command("signal")
  .description("Run the workspace tests of a run in progress on the fixed app and print the coverage signal")
  .argument("<run_dir>", "run folder")
  .action(signal)

program
  .command("pilot")
  .description("Print the cost pilot report of one run, with an estimate for the full grid")
  .argument("<run_id>", "run to report on")
  .option("--runs-dir <dir>", "folder that holds the run folders", "runs")
  .option("--concurrency <n>", "runs at a time for each agent", wholeAboveZero, 1)
  .action(pilot)

function wholeAboveZero(value: string) {
  if (!/^[1-9]\d*$/.test(value)) throw new InvalidArgumentError("must be a whole number above 0")
  return Number(value)
}

try {
  await program.parseAsync()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
