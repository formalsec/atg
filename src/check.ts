export type Check = { name: string; ok: boolean; detail: string }

export async function check(name: string, detail: () => Promise<string>): Promise<Check> {
  try {
    return { name, ok: true, detail: await detail() }
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}
