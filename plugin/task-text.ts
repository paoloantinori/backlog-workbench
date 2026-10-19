export type SegmentKind = 'plain' | 'link' | 'file' | 'task'
export type Segment = { kind: SegmentKind; text: string }

const MAX_HIGHLIGHTS = 128
const TASK_ID = /^[A-Za-z][A-Za-z0-9]{0,31}-\d+(?:\.\d+){0,9}$/
const DELIMITER = /[\s[\](){}<>"'`,;:!?]/
const EXTENSIONS = new Set([
  'adoc', 'c', 'css', 'go', 'h', 'java', 'js', 'json', 'jsx', 'md', 'mjs', 'cjs',
  'properties', 'py', 'rb', 'rs', 'sh', 'toml', 'ts', 'tsx', 'xml', 'yaml', 'yml',
])
const SPECIAL_NAMES = new Set(['dockerfile', 'makefile'])
const isAscii = (text: string) => /^[\x00-\x7f]*$/.test(text)

function isFilename(name: string): boolean {
  if (/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return true
  if (SPECIAL_NAMES.has(name.toLowerCase())) return true
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)\.([A-Za-z]+)$/.exec(name)
  return !!match && EXTENSIONS.has(match[2]!.toLowerCase())
}

function isPath(path: string): boolean {
  if (!path.includes('/') || !/^(?:~\/|\.{1,2}\/|\/)?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/?$/.test(path)) return false
  const rooted = /^(?:\/|\.\.?\/|~\/)/.test(path)
  return rooted || !path.slice(0, path.indexOf('/')).includes('.')
}

function urlEnd(text: string, start: number): number {
  let end = start
  let parentheses = 0
  let brackets = 0
  while (end < text.length && !/[\s<>"'`{}]/.test(text[end]!)) {
    const char = text[end]!
    if (char === '(') parentheses++
    if (char === ')' && --parentheses < 0) break
    if (char === '[') brackets++
    if (char === ']' && --brackets < 0) break
    end++
  }
  while (end > start && /[.,;:!?]/.test(text[end - 1]!)) end--
  return end
}

export function taskSegments(text: string): Segment[] {
  const segments: Segment[] = []
  let plain = ''
  let highlights = 0
  let i = 0
  while (i < text.length) {
    if (highlights === MAX_HIGHLIGHTS) { plain += text.slice(i); break }
    if (DELIMITER.test(text[i]!)) { plain += text[i++]!; continue }
    const start = i
    let end = start
    let kind: SegmentKind = 'plain'
    if (text.startsWith('https://', start) || text.startsWith('http://', start)) {
      end = urlEnd(text, start)
      const url = text.slice(start, end)
      if (isAscii(url) && /^https?:\/\/[A-Za-z0-9\[][^\s]*$/.test(url)) kind = 'link'
    } else {
      while (end < text.length && !DELIMITER.test(text[end]!)) end++
      while (end > start && text[end - 1] === '.') end--
      const token = text.slice(start, end)
      if (isAscii(token) && !token.includes('@')) {
        if (isPath(token) || isFilename(token)) kind = 'file'
        else if (TASK_ID.test(token)) kind = 'task'
      }
    }
    if (end === start) { plain += text[i++]!; continue }
    const value = text.slice(start, end)
    if (kind === 'plain') plain += value
    else {
      if (plain) { segments.push({ kind: 'plain', text: plain }); plain = '' }
      segments.push({ kind, text: value })
      highlights++
    }
    i = end
  }
  if (plain) segments.push({ kind: 'plain', text: plain })
  return segments
}
