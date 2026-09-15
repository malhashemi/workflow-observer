/**
 * Read a workflow script's leading `export const meta = {...}` as inert data.
 *
 * This module ships inside the plugin, so it deliberately has no package
 * dependencies. Its small recursive-descent parser accepts the pure literal
 * subset promised by the workflow contract: objects, arrays, strings, finite
 * numbers, booleans, null, comments, and trailing commas. It never asks a
 * JavaScript engine to compile or evaluate source text.
 */

const IDENTIFIER = /^[A-Za-z_$][\w$]*/u
const NUMBER = /^[+-]?(?:0[xX][\dA-Fa-f](?:_?[\dA-Fa-f])*|0[bB][01](?:_?[01])*|0[oO][0-7](?:_?[0-7])*|(?:(?:\d(?:_?\d)*)?\.\d(?:_?\d)*|\d(?:_?\d)*\.?(?:\d(?:_?\d)*)?)(?:[eE][+-]?\d(?:_?\d)*)?)/u
const SIMPLE_ESCAPES = Object.freeze({
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  0: '\0',
})

class MetaParseError extends SyntaxError {}

function fail(reader, message) {
  const before = reader.source.slice(0, reader.index)
  const line = before.split(/\r\n|\r|\n/u).length
  const lastBreak = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'))
  const column = reader.index - lastBreak
  throw new MetaParseError(`${message} at ${line}:${column} — meta must be a pure data literal`)
}

function skipLineComment(reader) {
  reader.index += 2
  while (reader.index < reader.source.length && !/[\r\n]/u.test(reader.source[reader.index])) reader.index++
}

function skipBlockComment(reader) {
  const end = reader.source.indexOf('*/', reader.index + 2)
  if (end < 0) fail(reader, 'unterminated block comment before or inside meta')
  reader.index = end + 2
}

function skipTrivia(reader) {
  while (reader.index < reader.source.length) {
    if (/\s/u.test(reader.source[reader.index])) {
      reader.index++
    } else if (reader.source.startsWith('//', reader.index)) {
      skipLineComment(reader)
    } else if (reader.source.startsWith('/*', reader.index)) {
      skipBlockComment(reader)
    } else {
      return
    }
  }
}

function readIdentifier(reader) {
  const match = reader.source.slice(reader.index).match(IDENTIFIER)
  if (!match) fail(reader, 'expected an identifier')
  reader.index += match[0].length
  return match[0]
}

function expectIdentifier(reader, expected) {
  skipTrivia(reader)
  const start = reader.index
  const actual = readIdentifier(reader)
  if (actual !== expected) {
    reader.index = start
    fail(reader, `missing \`export const meta = {...}\` as the first statement (expected ${expected})`)
  }
}

function expectPunctuator(reader, expected) {
  skipTrivia(reader)
  if (!reader.source.startsWith(expected, reader.index)) fail(reader, `expected ${JSON.stringify(expected)}`)
  reader.index += expected.length
}

function readHex(reader, length, label) {
  const raw = reader.source.slice(reader.index, reader.index + length)
  if (raw.length !== length || !new RegExp(`^[0-9A-Fa-f]{${length}}$`, 'u').test(raw)) fail(reader, `invalid ${label} escape`)
  reader.index += length
  return Number.parseInt(raw, 16)
}

function readUnicodeEscape(reader) {
  if (reader.source[reader.index] !== '{') return String.fromCharCode(readHex(reader, 4, 'Unicode'))
  const end = reader.source.indexOf('}', reader.index + 1)
  const raw = end < 0 ? '' : reader.source.slice(reader.index + 1, end)
  if (!/^[0-9A-Fa-f]+$/u.test(raw)) fail(reader, 'invalid code-point escape')
  const point = Number.parseInt(raw, 16)
  if (point > 0x10ffff) fail(reader, 'Unicode code point is out of range')
  reader.index = end + 1
  return String.fromCodePoint(point)
}

function readEscape(reader) {
  const escaped = reader.source[reader.index++]
  if (Object.hasOwn(SIMPLE_ESCAPES, escaped)) return SIMPLE_ESCAPES[escaped]
  if (escaped === 'x') return String.fromCharCode(readHex(reader, 2, 'hex'))
  if (escaped === 'u') return readUnicodeEscape(reader)
  if (escaped === '\n') return ''
  if (escaped === '\r') {
    if (reader.source[reader.index] === '\n') reader.index++
    return ''
  }
  if (escaped === undefined) fail(reader, 'unterminated string escape')
  return escaped
}

function readString(reader) {
  const quote = reader.source[reader.index++]
  let value = ''
  while (reader.index < reader.source.length) {
    const char = reader.source[reader.index++]
    if (char === quote) return value
    if (char === '\\') value += readEscape(reader)
    else if (/[\r\n]/u.test(char)) fail(reader, 'unescaped newline in a string')
    else value += char
  }
  fail(reader, 'unterminated string')
}

function readNumber(reader) {
  const match = reader.source.slice(reader.index).match(NUMBER)
  if (!match) fail(reader, 'invalid number')
  reader.index += match[0].length
  if (/[A-Za-z_$]/u.test(reader.source[reader.index] || '')) fail(reader, 'numeric suffixes are not data literals')
  const literal = match[0].replaceAll('_', '')
  const signedRadix = /^[+-]0[xXbBoO]/u.test(literal)
  const value = signedRadix
    ? (literal[0] === '-' ? -1 : 1) * Number(literal.slice(1))
    : Number(literal)
  if (!Number.isFinite(value)) fail(reader, 'meta numbers must be finite')
  return value
}

function isQuote(char) {
  return char === "'" || char === '"'
}

function readKey(reader) {
  skipTrivia(reader)
  const char = reader.source[reader.index]
  if (isQuote(char)) return readString(reader)
  if (/[A-Za-z_$]/u.test(char || '')) return readIdentifier(reader)
  if (/\d/u.test(char || '')) return String(readNumber(reader))
  fail(reader, 'object keys must be identifiers, strings, or numbers')
}

function readArray(reader) {
  const value = []
  expectPunctuator(reader, '[')
  skipTrivia(reader)
  while (reader.source[reader.index] !== ']') {
    if (reader.source[reader.index] === ',') fail(reader, 'meta arrays cannot contain holes')
    value.push(readValue(reader))
    skipTrivia(reader)
    if (reader.source[reader.index] !== ',') break
    reader.index++
    skipTrivia(reader)
  }
  expectPunctuator(reader, ']')
  return value
}

function readObject(reader) {
  const value = Object.create(null)
  expectPunctuator(reader, '{')
  skipTrivia(reader)
  while (reader.source[reader.index] !== '}') {
    const key = readKey(reader)
    expectPunctuator(reader, ':')
    value[key] = readValue(reader)
    skipTrivia(reader)
    if (reader.source[reader.index] !== ',') break
    reader.index++
    skipTrivia(reader)
  }
  expectPunctuator(reader, '}')
  return value
}

function readKeywordValue(reader) {
  const value = readIdentifier(reader)
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  fail(reader, `identifier ${JSON.stringify(value)} is not literal data`)
}

function readValue(reader) {
  skipTrivia(reader)
  const char = reader.source[reader.index]
  if (char === '{') return readObject(reader)
  if (char === '[') return readArray(reader)
  if (isQuote(char)) return readString(reader)
  if (/[+\-.\d]/u.test(char || '')) return readNumber(reader)
  if (/[A-Za-z_$]/u.test(char || '')) return readKeywordValue(reader)
  if (char === '`') fail(reader, 'template strings are not literal metadata')
  fail(reader, `unexpected ${JSON.stringify(char || 'end of source')}`)
}

export function parseWorkflowMeta(source) {
  const reader = { source, index: 0 }
  expectIdentifier(reader, 'export')
  expectIdentifier(reader, 'const')
  expectIdentifier(reader, 'meta')
  expectPunctuator(reader, '=')
  const meta = readValue(reader)
  if (meta === null || Array.isArray(meta) || typeof meta !== 'object') fail(reader, 'meta must be an object')
  return meta
}

export function extractMeta(source, errors = []) {
  try {
    return parseWorkflowMeta(source)
  } catch (error) {
    errors.push(error instanceof MetaParseError ? error.message : `could not parse meta: ${error.message}`)
    return null
  }
}
