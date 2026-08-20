import { IcsSyntaxError, type SourcePosition } from './errors.js'

export { IcsSyntaxError } from './errors.js'

export interface CalendarProperty {
  name: string
  params: Record<string, string[]>
  value: string
  line: number
  column: number
}

export interface CalendarComponent {
  name: string
  properties: CalendarProperty[]
  components: CalendarComponent[]
  line: number
}

// A segment records where a stretch of a logical (unfolded) line's text
// actually came from in the source, so an error found at some offset into
// the unfolded string can be traced back to a real line and column.
interface Segment {
  startOffset: number
  line: number
  startColumn: number
}

interface LogicalLine {
  text: string
  segments: Segment[]
}

function splitPhysicalLines(raw: string): string[] {
  return raw.split(/\r\n|\r|\n/)
}

// RFC 5545 "folding": a content line may be split across physical lines by
// inserting a CRLF followed by a single space or tab. Unfolding removes
// that whitespace and glues the pieces back together.
function unfold(physicalLines: string[]): LogicalLine[] {
  const logicalLines: LogicalLine[] = []
  let current: LogicalLine | null = null

  for (let i = 0; i < physicalLines.length; i++) {
    const lineNumber = i + 1
    const rawLine = physicalLines[i]

    // A trailing blank line is just the newline at end-of-file, not content.
    if (rawLine.length === 0 && i === physicalLines.length - 1) continue

    const firstChar = rawLine.charAt(0)
    const isContinuation = current !== null && (firstChar === ' ' || firstChar === '\t')

    if (isContinuation) {
      current!.segments.push({
        startOffset: current!.text.length,
        line: lineNumber,
        startColumn: 2, // column 1 was the folding whitespace, now discarded
      })
      current!.text += rawLine.slice(1)
    } else {
      if (current) logicalLines.push(current)
      current = { text: rawLine, segments: [{ startOffset: 0, line: lineNumber, startColumn: 1 }] }
    }
  }
  if (current) logicalLines.push(current)
  return logicalLines
}

function resolvePosition(line: LogicalLine, offset: number): SourcePosition {
  let match = line.segments[0]
  for (const segment of line.segments) {
    if (segment.startOffset <= offset) match = segment
    else break
  }
  return { line: match.line, column: match.startColumn + (offset - match.startOffset) }
}

// Thrown while scanning a single content line, before we know the real
// source position; parseCalendar catches it and maps the offset back.
class ContentLineError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message)
  }
}

interface RawContentLine {
  name: string
  nameOffset: number
  params: Record<string, string[]>
  value: string
  valueOffset: number
}

// contentline = name *(";" param) ":" value, per RFC 5545 section 3.1.
function parseContentLine(text: string): RawContentLine {
  let i = 0
  while (i < text.length && text[i] !== ';' && text[i] !== ':') i++
  if (i === 0) throw new ContentLineError('expected a property name before ":" or ";"', 0)
  const name = text.slice(0, i).toUpperCase()

  const params: Record<string, string[]> = {}
  while (i < text.length && text[i] === ';') {
    i++
    const paramNameStart = i
    while (i < text.length && text[i] !== '=') i++
    if (i >= text.length) {
      throw new ContentLineError(`parameter "${text.slice(paramNameStart)}" is missing "="`, paramNameStart)
    }
    const paramName = text.slice(paramNameStart, i).toUpperCase()
    i++ // skip '='

    const values: string[] = []
    for (;;) {
      let value: string
      if (text[i] === '"') {
        const quoteStart = i
        i++
        const contentStart = i
        while (i < text.length && text[i] !== '"') i++
        if (i >= text.length) throw new ContentLineError('unterminated quoted parameter value', quoteStart)
        value = text.slice(contentStart, i)
        i++ // skip closing quote
      } else {
        const start = i
        while (i < text.length && text[i] !== ',' && text[i] !== ';' && text[i] !== ':') i++
        value = text.slice(start, i)
      }
      values.push(value)
      if (text[i] === ',') {
        i++
        continue
      }
      break
    }
    params[paramName] = values
  }

  if (text[i] !== ':') throw new ContentLineError('expected ":" to start the property value', i)
  i++ // skip ':'
  return { name, nameOffset: 0, params, value: text.slice(i), valueOffset: i }
}

export function parseCalendar(raw: string): CalendarComponent {
  const physicalLines = splitPhysicalLines(raw)
  const logicalLines = unfold(physicalLines)

  const errorAtOffset = (message: string, line: LogicalLine, offset: number): IcsSyntaxError => {
    const position = resolvePosition(line, offset)
    return new IcsSyntaxError(message, position, physicalLines[position.line - 1] ?? '')
  }

  const errorAtLine = (message: string, lineNumber: number): IcsSyntaxError => {
    return new IcsSyntaxError(message, { line: lineNumber, column: 1 }, physicalLines[lineNumber - 1] ?? '')
  }

  const stack: CalendarComponent[] = []
  let root: CalendarComponent | null = null

  for (const logicalLine of logicalLines) {
    if (logicalLine.text.length === 0) continue

    let parsed: RawContentLine
    try {
      parsed = parseContentLine(logicalLine.text)
    } catch (err) {
      if (err instanceof ContentLineError) throw errorAtOffset(err.message, logicalLine, err.offset)
      throw err
    }

    const position = resolvePosition(logicalLine, parsed.valueOffset)

    if (parsed.name === 'BEGIN') {
      const component: CalendarComponent = {
        name: parsed.value.toUpperCase(),
        properties: [],
        components: [],
        line: position.line,
      }
      if (stack.length === 0) {
        if (component.name !== 'VCALENDAR') {
          throw errorAtOffset(
            `expected "BEGIN:VCALENDAR" at the start of the file, found "BEGIN:${component.name}"`,
            logicalLine,
            parsed.valueOffset,
          )
        }
        root = component
      } else {
        stack[stack.length - 1].components.push(component)
      }
      stack.push(component)
      continue
    }

    if (parsed.name === 'END') {
      const open = stack.pop()
      if (!open) {
        throw errorAtOffset(`found "END:${parsed.value}" with no matching "BEGIN"`, logicalLine, parsed.valueOffset)
      }
      if (open.name !== parsed.value.toUpperCase()) {
        throw errorAtOffset(
          `expected "END:${open.name}" (opened at line ${open.line}), found "END:${parsed.value.toUpperCase()}"`,
          logicalLine,
          parsed.valueOffset,
        )
      }
      continue
    }

    if (stack.length === 0) {
      throw errorAtOffset(`property "${parsed.name}" appears outside of any component`, logicalLine, 0)
    }
    stack[stack.length - 1].properties.push({
      name: parsed.name,
      params: parsed.params,
      value: parsed.value,
      line: position.line,
      column: position.column,
    })
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1]
    throw errorAtLine(`reached end of file with unclosed "BEGIN:${unclosed.name}"`, unclosed.line)
  }
  if (!root) {
    throw new IcsSyntaxError('file contains no "BEGIN:VCALENDAR" component', { line: 1, column: 1 }, physicalLines[0] ?? '')
  }

  requireProperty(root, 'VERSION', errorAtLine)
  requireProperty(root, 'PRODID', errorAtLine)
  for (const component of root.components) {
    if (component.name === 'VEVENT') {
      requireProperty(component, 'UID', errorAtLine)
      requireProperty(component, 'DTSTAMP', errorAtLine)
      requireProperty(component, 'DTSTART', errorAtLine)
    }
  }

  return root
}

function requireProperty(
  component: CalendarComponent,
  name: string,
  errorAtLine: (message: string, lineNumber: number) => IcsSyntaxError,
): void {
  if (!component.properties.some((property) => property.name === name)) {
    throw errorAtLine(`"${component.name}" is missing required property "${name}"`, component.line)
  }
}
