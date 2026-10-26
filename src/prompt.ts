import { readFile } from "node:fs/promises"

export const promptTemplate = await readFile(new URL("prompt.md", import.meta.url), "utf8")

export function renderPrompt(template: string, tags: string[], values: Record<string, string>) {
  return template
    .split("\n")
    .flatMap(line => {
      const tagged = line.match(/^\[(\w+)\] (.*)$/)
      if (!tagged) return [line]
      return tags.includes(tagged[1]) ? [tagged[2]] : []
    })
    .join("\n")
    .replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
      if (values[key] === undefined) throw new Error(`the prompt template needs a value for {{${key}}}`)
      return values[key]
    })
}
