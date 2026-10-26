#!/usr/bin/env node
import { Command } from "commander"
import { listApps } from "./commands/apps.ts"
import { newConfig } from "./commands/new.ts"
import { schema } from "./commands/schema.ts"
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

try {
  await program.parseAsync()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
