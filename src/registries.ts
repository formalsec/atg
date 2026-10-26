export type Descriptor = {
  name: string
  label: string
  implemented: boolean
}

export const agents: Descriptor[] = [
  { name: "claude", label: "Claude Code", implemented: true },
  { name: "codex", label: "Codex CLI", implemented: false },
  { name: "gemini", label: "Gemini CLI", implemented: false },
]

export const frameworks: Descriptor[] = [
  { name: "playwright", label: "Playwright", implemented: true },
  { name: "selenium", label: "Selenium", implemented: false },
  { name: "cypress", label: "Cypress", implemented: false },
]

export const coverageTools: Descriptor[] = [
  { name: "lines", label: "Lines of app code executed", implemented: true },
  { name: "html", label: "HTML elements exercised", implemented: true },
  { name: "api", label: "API endpoints called", implemented: true },
]
