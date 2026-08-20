// No @types/node in this project (zero third-party dependencies), so the
// handful of Node built-ins the CLI touches are declared by hand below.
declare const process: {
  argv: string[]
  exit(code?: number): never
  stdout: { write(chunk: string): void }
  stderr: { write(chunk: string): void }
}

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string
}

import { readFileSync } from 'node:fs'
import { parseCalendar, IcsSyntaxError } from './calendar.js'

function main(): void {
  const path = process.argv[2]
  if (!path) {
    process.stderr.write('usage: icslint <file.ics>\n')
    process.exit(2)
  }

  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    process.stderr.write(`could not read "${path}": ${(err as Error).message}\n`)
    process.exit(2)
  }

  try {
    const calendar = parseCalendar(raw)
    const eventCount = calendar.components.filter((component) => component.name === 'VEVENT').length
    process.stdout.write(`${path}: ok, ${eventCount} event${eventCount === 1 ? '' : 's'}\n`)
  } catch (err) {
    if (err instanceof IcsSyntaxError) {
      process.stderr.write(`${path}: ${err.message}\n`)
      process.exit(1)
    }
    throw err
  }
}

main()
