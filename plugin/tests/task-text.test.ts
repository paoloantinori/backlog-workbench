import { expect, test } from 'claude-code/testing'
import { taskSegments } from '../task-text'
import type { Segment } from '../task-text'

const compose = (segments: Segment[]) => segments.map(segment => segment.text).join('')
const kinds = (segments: Segment[]) => segments.filter(segment => segment.kind !== 'plain').map(segment => `${segment.kind}:${segment.text}`)

test('plain text passes through as one plain segment', () => {
  const input = 'Esempio di testo ordinario, senza riferimenti.'
  expect(taskSegments(input)).toEqual([{ kind: 'plain', text: input }])
})

test('empty text yields no segments', () => {
  expect(taskSegments('')).toEqual([])
})

test('https URL with query and fragment is a link', () => {
  const input = 'Vedi https://example.com/docs/page?q=1&lang=it#sezione qui'
  const segments = taskSegments(input)
  expect(compose(segments)).toBe(input)
  expect(kinds(segments)).toEqual(['link:https://example.com/docs/page?q=1&lang=it#sezione'])
})

test('http URL with trailing punctuation keeps punctuation plain', () => {
  const input = 'Guarda http://example.com/a/b.'
  const segments = taskSegments(input)
  expect(compose(segments)).toBe(input)
  expect(kinds(segments)).toEqual(['link:http://example.com/a/b'])
})

test('markdown link keeps delimiters plain', () => {
  const input = 'La [documentazione](https://example.com/guide) è chiara.'
  const segments = taskSegments(input)
  expect(compose(segments)).toBe(input)
  expect(kinds(segments)).toEqual(['link:https://example.com/guide'])
})

test('balanced parentheses inside a URL are retained', () => {
  const input = 'Pagina https://it.wikipedia.org/wiki/Backlog_(informatica) utile'
  const segments = taskSegments(input)
  expect(compose(segments)).toBe(input)
  expect(kinds(segments)).toEqual(['link:https://it.wikipedia.org/wiki/Backlog_(informatica)'])
})

test('relative path with directory is a file', () => {
  const input = 'Modifica src/hooks/register.tsx e poi ricompila'
  const segments = taskSegments(input)
  expect(compose(segments)).toBe(input)
  expect(kinds(segments)).toEqual(['file:src/hooks/register.tsx'])
})

test('absolute and tilde paths are files', () => {
  for (const path of ['/etc/config.yml', '~/data/repo/personal/pom.xml', './scripts/build.sh', '../docs/README.md']) {
    const input = `Apri ${path} ora`
    const segments = taskSegments(input)
    expect(compose(segments)).toBe(input)
    expect(kinds(segments)).toEqual([`file:${path}`])
  }
})

test('bare common filenames are files', () => {
  for (const name of ['pom.xml', 'README.md', 'config.yml', 'Dockerfile', 'Makefile', '.gitignore']) {
    const input = `Controlla ${name} nel repository`
    const segments = taskSegments(input)
    expect(compose(segments)).toBe(input)
    expect(kinds(segments)).toEqual([`file:${name}`])
  }
})

test('unknown extensions and dot-less tokens stay plain', () => {
  const input = 'Il binario eseguibile e la nota senza estensione restano normali'
  expect(taskSegments(input)).toEqual([{ kind: 'plain', text: input }])
})

test('task IDs with prefix and subtask numbering are tasks', () => {
  for (const id of ['REG-469', 'DEMO-12.1', 'AB12-3.4.5']) {
    const input = `Chiudi ${id} prima del rilascio`
    const segments = taskSegments(input)
    expect(compose(segments)).toBe(input)
    expect(kinds(segments)).toEqual([`task:${id}`])
  }
})

test('trailing dot after a task ID stays plain', () => {
  const input = 'Completa REG-469.'
  const segments = taskSegments(input)
  expect(compose(segments)).toBe(input)
  expect(kinds(segments)).toEqual(['task:REG-469'])
})

test('task ID with letters or extension suffix stays plain', () => {
  for (const input of ['Il ref REG-469abc resta normale', 'Il file REG-469.rc resta normale']) {
    expect(taskSegments(input)).toEqual([{ kind: 'plain', text: input }])
  }
})

test('a numeric suffix is not an extension so DEMO-12.1 stays a task while demo-1.md is a file', () => {
  const input = 'Confronta DEMO-12.1 con demo-1.md'
  const segments = taskSegments(input)
  expect(compose(segments)).toBe(input)
  expect(kinds(segments)).toEqual(['task:DEMO-12.1', 'file:demo-1.md'])
})

test('emails, versions, and bare domains stay plain', () => {
  for (const input of [
    'Scrivi a user@example.com per i dettagli',
    'Aggiornato alla versione 1.54.0 ieri',
    'Il dominio example.com non ha schema',
  ]) {
    expect(taskSegments(input)).toEqual([{ kind: 'plain', text: input }])
  }
})

test('path-like text inside an email address stays plain', () => {
  const input = 'Inoltra a admin@pom.xml.example.com thanks'
  expect(taskSegments(input)).toEqual([{ kind: 'plain', text: input }])
})

test('tokens with non-ASCII characters stay entirely plain', () => {
  const input = 'Il task RÉG-469 e il file config-日本.yml restano normali'
  expect(taskSegments(input)).toEqual([{ kind: 'plain', text: input }])
})

test('unicode prose around ASCII highlights is preserved', () => {
  const input = 'Obiettivo: REG-7 e poi la parte æ, which… fine'
  const segments = taskSegments(input)
  expect(compose(segments)).toBe(input)
  expect(kinds(segments)).toEqual(['task:REG-7'])
})

test('newlines and backticks are preserved as plain boundaries', () => {
  const input = 'Prima riga `REG-3`\nseconda riga `src/a/b.ts`'
  const segments = taskSegments(input)
  expect(compose(segments)).toBe(input)
  expect(kinds(segments)).toEqual(['task:REG-3', 'file:src/a/b.ts'])
})

test('highlight count caps at 128 and the remainder stays plain', () => {
  const input = Array.from({ length: 140 }, (_, i) => `REG-${i + 1}`).join(' ')
  const segments = taskSegments(input)
  expect(compose(segments)).toBe(input)
  expect(segments.filter(segment => segment.kind === 'task')).toHaveLength(128)
  expect(kinds(segments)).toHaveLength(128)
})

test('the same position prefers URL over path over file over task', () => {
  const input = 'https://example.com/README.md e doc/README.md e README.md e REG-5'
  const segments = taskSegments(input)
  expect(compose(segments)).toBe(input)
  expect(kinds(segments)).toEqual([
    'link:https://example.com/README.md',
    'file:doc/README.md',
    'file:README.md',
    'task:REG-5',
  ])
})

test('URLs keep their trailing slash and exclude unmatched closing punctuation', () => {
  for (const [input, link] of [
    ['https://example.test/', 'https://example.test/'],
    ['Vedi https://example.test/a).', 'https://example.test/a'],
    ['[Guida](https://example.test/a_(b)).', 'https://example.test/a_(b)'],
    ['<https://example.test/a?q=1&file=README.md#REG-2>', 'https://example.test/a?q=1&file=README.md#REG-2'],
  ]) {
    const segments = taskSegments(input!)
    expect(compose(segments)).toBe(input)
    expect(kinds(segments)).toEqual([`link:${link}`])
  }
})

test('Unicode URLs and invalid schemes do not produce highlighted fragments', () => {
  for (const input of ['https://example.test/café/REG-2', 'https://esempio.test/日本.yml', 'https://', 'mailto:user@README.md']) {
    expect(taskSegments(input)).toEqual([{ kind: 'plain', text: input }])
  }
})

test('multi-dot files and extensionless explicit paths are recognized whole', () => {
  const input = 'config.test.ts state.d.ts /etc/hosts ./mvnw src/main backlog/tasks/demo-1.md'
  const segments = taskSegments(input)
  expect(compose(segments)).toBe(input)
  expect(kinds(segments)).toEqual([
    'file:config.test.ts', 'file:state.d.ts', 'file:/etc/hosts', 'file:./mvnw', 'file:src/main', 'file:backlog/tasks/demo-1.md',
  ])
})

test('punctuation does not expose partial references or become a dotfile', () => {
  for (const input of ['..', '...', '--REG-1--', 'REG-2-', 'REG-2.rc', 'example.com/README.md', 'v1.54.0']) {
    expect(taskSegments(input)).toEqual([{ kind: 'plain', text: input }])
  }
})

test('every segment concatenates back to the exact input', () => {
  const inputs = [
    '', ' ', '\n', 'a', 'a/b', 'https://a.b', 'x'.repeat(3000),
    'Mixed https://e.com/p_(q)?r=1&x REG-1.2.3 e cfg/app.yml fine.',
    'REG-469abc REG-469. REG-469.rc DEMO-12.1 demo-1.md 1.54.0 user@e.com',
    '-REG-1- -src/x.ts- (docs/d.md) [label](https://e.com/a)',
  ]
  for (const input of inputs) expect(compose(taskSegments(input))).toBe(input)
})
