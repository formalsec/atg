#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from "commander"
import { listApps } from "./commands/apps.ts"
import { doctor } from "./commands/doctor.ts"
import { evaluateRun, evaluationStages } from "./commands/eval.ts"
import { newConfig } from "./commands/new.ts"
import { pilot } from "./commands/pilot.ts"
import { run } from "./commands/run.ts"
import { schema } from "./commands/schema.ts"
import { signal } from "./commands/signal.ts"
import { validate } from "./commands/validate.ts"

const program = new Command("atg").description("Benchmark coding agents that generate E2E test suites")

program
  .command("validate")
  .description("Check config files and print each normalized config with its run_id")
  .argument("<config...>", "config files to check")
  .option("--json", "print the results as JSON")
  .action(validate)

program
  .command("schema")
  .description("Print the config JSON Schema")
  .option("--out <file>", "write the schema to a file instead of stdout")
  .action(schema)

program
  .command("apps")
  .description("List the apps and the inputs each one provides")
  .option("--json", "print the apps as JSON")
  .action(listApps)

program
  .command("new")
  .description("Create a config with an interactive wizard")
  .option("--out <file>", "where to write the config (default: <run_id>.json)")
  .option("--from <config>", "prefill the wizard from an existing config")
  .action(newConfig)

program
  .command("run")
  .description("Run one config: prepare the workspace, call the agent, evaluate its suite, write metrics")
  .argument("<config>", "config file")
  .option("--dry-run", "prepare the workspace and prompt, print the agent invocation, and stop")
  .option("--force", "redo the run even when it is done")
  .option("--runs-dir <dir>", "folder that holds the run folders", "runs")
  .option("--keep-workspace", "keep the agent workspace after the run")
  .action(run)

program
  .command("eval")
  .description("Evaluate a finished run again from its saved tests, without calling the agent, and rewrite metrics.json")
  .argument("<run_id>", "run to evaluate")
  .addOption(new Option("--only <stage>", "run only this evaluation stage").choices(Object.keys(evaluationStages)))
  .option("--runs-dir <dir>", "folder that holds the run folders", "runs")
  .action(evaluateRun)

program
  .command("signal")
  .description("Run the workspace tests of a run in progress on the running fixed app and print the coverage signal")
  .argument("<run_dir>", "run folder")
  .action(signal)

program
  .command("pilot")
  .description("Print the cost pilot report of one run, with an estimate for the full grid")
  .argument("<run_id>", "run to report on")
  .option("--runs-dir <dir>", "folder that holds the run folders", "runs")
  .option("--concurrency <n>", "runs at a time for each agent", wholeAboveZero, 1)
  .action(pilot)

program
  .command("doctor")
  .description("Check that the agent CLIs, the test frameworks and the app start commands are ready")
  .action(doctor)

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
