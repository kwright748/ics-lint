# ics-lint

A small TypeScript library for parsing and validating iCalendar (`.ics`)
files, with a CLI on top.

## Why

Most `.ics` parsing libraries either accept anything and silently produce
garbage, or throw a bare `Error: invalid ical` with no indication of which
line, which property, or which character caused it. If you've ever had to
binary-search a 4,000-line calendar export to find a malformed `DTSTART`,
you know how much time that costs.

This library tries to make every parse failure point at an exact line and
column, with the offending source line and a caret under the problem, the
way a compiler error does.

## Status

Early skeleton. It correctly unfolds RFC 5545 line folding, parses content
lines (name, parameters, value), builds the `VCALENDAR` / `VEVENT` /
component tree, checks for a handful of required properties, validates the
`DATE`/`DATE-TIME` format of `DTSTART` and `DTEND` values, and parses and
validates `RRULE` recurrence rules. It does not yet unescape `TEXT` values.
See "What's not here yet" below.

## Usage

```ts
import { parseCalendar, IcsSyntaxError } from './src/calendar.js'

const source = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//example//ics-lint//EN
BEGIN:VEVENT
UID:1234@example.com
DTSTAMP:20260115T090000Z
DTSTART:20260115T100000Z
SUMMARY:Team sync
END:VEVENT
END:VCALENDAR
`

try {
  const calendar = parseCalendar(source)
  console.log(calendar.components.length, 'top-level components')
} catch (err) {
  if (err instanceof IcsSyntaxError) {
    console.error(err.message)
  } else {
    throw err
  }
}
```

Given a broken file, for example a `VEVENT` missing its `UID`:

```
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//example//ics-lint//EN
BEGIN:VEVENT
DTSTAMP:20260115T090000Z
DTSTART:20260115T100000Z
END:VEVENT
END:VCALENDAR
```

`parseCalendar` throws an `IcsSyntaxError` whose message reads:

```
"VEVENT" is missing required property "UID"
  at line 4, column 1

    BEGIN:VEVENT
    ^
```

The error also carries `line`, `column`, and `lineText` as plain fields, so
callers building their own tooling (editor extensions, lint output, etc.)
don't have to parse the message string.

### CLI

```
npx tsc
node dist/cli.js path/to/calendar.ics
```

Prints `path/to/calendar.ics: ok, 3 events` on success, or the same
line/column diagnostic on failure, with exit code 1 for a parse error and
2 for a usage/file error.

## Design

- `src/errors.ts` — `IcsSyntaxError`, formats a message plus a source
  pointer from a line/column position.
- `src/calendar.ts` — unfolding, content-line scanning, component tree
  construction, and the small set of required-property checks.
- `src/cli.ts` — argument handling and stdout/stderr formatting.

The core trick for good error messages is that unfolding a wrapped line
doesn't just concatenate text, it keeps a list of "segments" recording
which physical line and column each stretch of the unfolded text came
from. When something later in that logical line fails to parse, the
offset into the unfolded string gets mapped back through those segments
to a real line and column, even if the property spans three folded lines.

Every `RRULE` property is parsed into a structured `RecurrenceRule` (on
`property.recurrence`) and validated against RFC 5545 section 3.3.10: a
recognized `FREQ`, integer ranges for the `BY*` parts (e.g. `BYMONTHDAY`
in `-31..31` excluding zero), a valid `BYDAY` weekday/ordinal like `2MO` or
`-1FR`, and the `COUNT`/`UNTIL` mutual exclusion rule. A bad part, such as
`FREQ=DAYLY` or `BYMONTH=13`, is reported at the exact column of that part
within the value, not just the start of the property.

## What's not here yet

- Cross-checking `TZID` parameters against declared `VTIMEZONE` components.
- Unescaping `TEXT` values (`\n`, `\,`, `\;`).
- A `--json` output mode for the CLI.
- Tests.

## Dependencies

None. Standard library only, both at runtime and in the type
declarations (see the hand-written `declare` blocks in `src/cli.ts`
instead of pulling in `@types/node`).

## License

MIT, see `LICENSE`.
