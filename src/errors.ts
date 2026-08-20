export interface SourcePosition {
  line: number
  column: number
}

// Modeled after compiler-style diagnostics: message, then the offending
// line with a caret under the exact column, so you never have to grep
// the file to find what "unexpected token" is talking about.
export class IcsSyntaxError extends Error {
  readonly line: number
  readonly column: number
  readonly lineText: string

  constructor(message: string, position: SourcePosition, lineText: string) {
    const pointer = ' '.repeat(Math.max(0, position.column - 1)) + '^'
    super(`${message}\n  at line ${position.line}, column ${position.column}\n\n    ${lineText}\n    ${pointer}`)
    this.name = 'IcsSyntaxError'
    this.line = position.line
    this.column = position.column
    this.lineText = lineText
  }
}
