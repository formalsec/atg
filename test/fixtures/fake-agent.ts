import { join } from "node:path"
import { type AgentAdapter, agents } from "../../src/registries.ts"

const script = join(import.meta.dirname, "fake-agent-process.ts")

const fake: AgentAdapter = {
  invocation: ({ agent }) => ({
    command: process.execPath,
    args: [script, agent.model],
    env: { FLAKY_COUNTER: process.env.FLAKY_COUNTER ?? "" },
    isolation: "none",
  }),
  parse: ({ stdout }) =>
    stdout.includes("suite written")
      ? {
          status: "ok",
          stop_reason: "success",
          turns: 3,
          tokens: { input: 10, output: 20, cache_read: 0, cache_creation: 0 },
          cost_usd: 0,
          cost_source: "fake",
          models: ["fake-model"],
        }
      : { status: "agent_error", error: "the fake agent wrote no suite" },
  activity: line => line || undefined,
  version: async () => "fake 1.0",
  checks: async () => [],
}

agents.push({ name: "fake", label: "Fake agent", implemented: true, adapter: fake })
