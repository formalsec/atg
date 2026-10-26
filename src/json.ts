import { readFile } from "node:fs/promises"

export async function readJson(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8")
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error}`)
  }
}
