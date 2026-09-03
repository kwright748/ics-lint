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

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/
const DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= daysInMonth[month - 1]
}

// DTSTART/DTEND are DATE-TIME by default, or DATE when VALUE=DATE is given.
// See RFC 5545 sections 3.3.4 (DATE) and 3.3.5 (DATE-TIME).
function validateDateTimeValue(value: string, params: Record<string, string[]>): string | null {
  const valueType = params.VALUE?.[0]?.toUpperCase()
  if (valueType !== undefined && valueType !== 'DATE' && valueType !== 'DATE-TIME') {
    return `unsupported VALUE type "${valueType}" (expected "DATE" or "DATE-TIME")`
  }

  if (valueType === 'DATE') {
    const match = DATE_RE.exec(value)
    if (!match) return `expected a DATE value in the form "YYYYMMDD", found "${value}"`
    const [, year, month, day] = match
    if (!isValidCalendarDate(Number(year), Number(month), Number(day))) {
      return `"${value}" is not a valid calendar date`
    }
    return null
  }

  const match = DATE_TIME_RE.exec(value)
  if (!match) {
    return `expected a DATE-TIME value in the form "YYYYMMDDTHHMMSS" (optionally with a trailing "Z"), found "${value}"`
  }
  const [, year, month, day, hour, minute, second, utc] = match
  if (!isValidCalendarDate(Number(year), Number(month), Number(day))) {
    return `"${value}" is not a valid calendar date`
  }
  if (Number(hour) > 23) return `"${value}" has an hour out of range (00-23)`
  if (Number(minute) > 59) return `"${value}" has a minute out of range (00-59)`
  if (Number(second) > 60) return `"${value}" has a second out of range (00-60)`
  if (utc && params.TZID) {
    return `"${value}" uses the UTC "Z" designator and cannot also have a "TZID" parameter`
  }
  return null
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

    if (parsed.name === 'DTSTART' || parsed.name === 'DTEND') {
      const error = validateDateTimeValue(parsed.value, parsed.params)
      if (error) throw errorAtOffset(error, logicalLine, parsed.valueOffset)
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
