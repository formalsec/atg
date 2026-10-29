import { styleText } from "node:util"

const frames = [..."·✢✳✶✻✽✻✶✳✢"]
const frameMs = 120
const barWidth = 30
const clearLine = "\r\x1b[2K"

type Progress = {
  plan: Record<string, number>
  done: number
  stage: string
  steps: number
  label: string
  started: number
  timer: NodeJS.Timeout
}

let progress: Progress | undefined

export function startProgress(plan: Record<string, number>) {
  if (!process.stderr.isTTY) return
  const timer = setInterval(draw, frameMs).unref()
  progress = { plan, done: 0, stage: "", steps: 0, label: "", started: performance.now(), timer }
}

export function stopProgress() {
  if (!progress) return
  clearInterval(progress.timer)
  process.stderr.write(clearLine)
  progress = undefined
}

export function say(line: string) {
  if (!progress) return console.error(line)
  process.stderr.write(`${clearLine}${line}\n`)
  draw()
}

export function beginStage(name: string) {
  if (!progress) return
  Object.assign(progress, { stage: name, steps: 0, label: name })
  draw()
}

export function endStage() {
  if (!progress) return
  progress.done += progress.plan[progress.stage] ?? 0
  Object.assign(progress, { stage: "", steps: 0 })
  draw()
}

export function showStep(label: string) {
  if (!progress) return
  progress.label = label
  draw()
}

export function stepDone() {
  if (!progress) return
  progress.steps++
  draw()
}

function draw() {
  if (!progress) return
  const { plan, done, stage, steps, label, started } = progress
  const total = Object.values(plan).reduce((sum, steps) => sum + steps, 0)
  const current = done + Math.min(steps, plan[stage] ?? 0)
  const fraction = total === 0 ? 0 : current / total
  const ms = performance.now() - started
  process.stderr.write(`${clearLine}${progressLine({ fraction, label, ms, columns: process.stderr.columns })}`)
}

export function progressLine({ fraction, label, ms, columns }: { fraction: number; label: string; ms: number; columns: number }) {
  const width = Math.max(0, Math.min(barWidth, columns - 30))
  const filled = Math.round(fraction * width)
  const head = `${Math.round(fraction * 100)}%  ${clock(ms)}  `
  const room = Math.max(0, columns - 1 - (width + 3) - head.length)
  const spinner = color("yellow", frames[Math.floor(ms / frameMs) % frames.length])
  const bar = `${color("yellow", "█".repeat(filled))}${color("dim", "░".repeat(width - filled))}`
  return `${spinner} ${bar} ${head}${label.slice(0, room)}`
}

function color(format: "yellow" | "dim", text: string) {
  return styleText(format, text, { stream: process.stderr })
}

function clock(ms: number) {
  const seconds = Math.floor(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
