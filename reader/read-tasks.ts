import { open, readdir, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join, matchesGlob, sep } from 'node:path'
import { parseTask } from './vendor/markdown/parser.ts'
import { parseFrontmatter } from './vendor/markdown/frontmatter.ts'
import { canonicalTaskId, normalizeTaskId } from './vendor/utils/task-id.ts'
import { buildGlobPattern } from './vendor/utils/prefix-config.ts'
import { sortTasks } from './vendor/utils/task-sorting.ts'

const TASK_ID = /^[A-Za-z][A-Za-z0-9]{0,31}-\d+(?:\.\d+){0,9}$/
const DIRECTORIES = [
  { path: 'backlog/tasks', active: true },
  { path: 'backlog/archive/tasks', active: false },
  { path: 'backlog/completed', active: false },
]
const MAX_FILE_BYTES = 1_048_576
const MAX_TOTAL_BYTES = 16_777_216
// macOS sys/fcntl.h; Node exposes O_NOFOLLOW for the last component only.
const O_NOFOLLOW_ANY = 0x20000000

type RecordFile = { task: ReturnType<typeof parseTask>; path: string; active: boolean }

async function within(root: string, path: string): Promise<string> {
  const resolved = await realpath(path)
  if (!resolved.startsWith(root + sep)) throw new Error(`Path outside project through symlink: ${path}`)
  return resolved
}

async function readFile(root: string, path: string, buffer: Buffer): Promise<string> {
  const filename = await within(root, join(root, path))
  const file = await open(filename, constants.O_RDONLY | O_NOFOLLOW_ANY | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error(`${path}: not a regular file`)
    if (stat.size > MAX_FILE_BYTES) throw new Error(`${path}: exceeds ${MAX_FILE_BYTES} bytes`)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null)
      if (bytesRead === 0) break
      size += bytesRead
    }
    if (size > MAX_FILE_BYTES) throw new Error(`${path}: exceeds ${MAX_FILE_BYTES} bytes`)
    return buffer.subarray(0, size).toString('utf8')
  } finally { await file.close() }
}

function normalizedId(value: string, fallbackPrefix: string): string {
  const raw = value.trim()
  const prefix = TASK_ID.test(raw) ? raw.slice(0, raw.indexOf('-')) : fallbackPrefix
  const id = normalizeTaskId(raw, prefix)
  if (!TASK_ID.test(id)) throw new Error(`Missing or invalid task identity: ${value}`)
  return id
}

function identity(id: string): string {
  return canonicalTaskId(id, id.slice(0, id.indexOf('-')))
}

async function corpus(root: string) {
  const groups = new Map<string, RecordFile[]>()
  const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
  const config = parseFrontmatter(`---\n${await readFile(root, 'backlog/config.yml', buffer)}\n---`).data
  const prefix = config.task_prefix ?? 'task'
  if (typeof prefix !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,31}$/.test(prefix)) throw new Error('Invalid configured task prefix')
  const pattern = buildGlobPattern(prefix.toLowerCase())
  const priorities = config.priorities
  if (priorities !== undefined && (!Array.isArray(priorities) || priorities.some(p => typeof p !== 'string'))) {
    throw new Error('Configured priorities must be a string list')
  }
  let total = 0
  for (const directory of DIRECTORIES) {
    let resolved: string
    try {
      resolved = await within(root, join(root, directory.path))
    } catch (error) {
      if (!directory.active && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const entry of (await readdir(resolved, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!matchesGlob(entry.name, pattern) || entry.isDirectory()) continue
      const path = `${directory.path}/${entry.name}`
      try {
        const content = await readFile(root, path, buffer)
        total += Buffer.byteLength(content)
        if (total > MAX_TOTAL_BYTES) throw new Error(`Backlog exceeds ${MAX_TOTAL_BYTES} bytes`)
        if (!/^---\r?\n/.test(content)) throw new Error('Only standalone YAML frontmatter is supported')
        const task = parseTask(content)
        task.id = normalizedId(task.id, prefix)
        if (!task.title) throw new Error('Missing task title')
        if (task.ordinal !== undefined && !Number.isFinite(task.ordinal)) throw new Error('Invalid ordinal')
        task.dependencies = task.dependencies.map(dependency => normalizedId(dependency, prefix))
        const key = identity(task.id)
        const group = groups.get(key) ?? []
        group.push({ task, path, active: directory.active })
        groups.set(key, group)
      } catch (error) {
        throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return { groups, priorities: priorities as string[] | undefined, prefix }
}

function trimTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

async function verifiedRoot(expected: string): Promise<string> {
  if (!expected.startsWith('/')) throw new Error('The expected project root must be an absolute canonical path')
  const root = trimTrailingSlashes(expected)
  if (root === '/') throw new Error('The filesystem root is not a supported project root')
  // The parent-verified path is the trust anchor. realpath(expected) is deliberately not
  // consulted: after a rename plus symlink swap of the root, canonicalizing expected at
  // child time would match the swapped cwd and accept the wrong project.
  const cwd = trimTrailingSlashes(await realpath(process.cwd()))
  if (cwd !== root) throw new Error(`Reader cwd ${cwd} is not the expected project root ${root}`)
  return root
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('This reader requires macOS O_NOFOLLOW_ANY protection')
  const argv = process.argv.slice(2)
  const usage = 'Usage: reader.cjs --root <canonical-root> list | view <task-id>'
  if (argv[0] !== '--root' || typeof argv[1] !== 'string' || argv[1] === '') throw new Error(usage)
  const [mode, requested, ...extra] = argv.slice(2)
  if (extra.length || (mode !== 'list' && mode !== 'view') || (mode === 'list' ? requested !== undefined : !requested)) {
    throw new Error(usage)
  }
  const root = await verifiedRoot(argv[1])
  const { groups, priorities, prefix } = await corpus(root)
  const id = requested === undefined ? undefined : normalizedId(requested, prefix)
  if (mode === 'list') {
    const conflicts = Array.from(groups, ([id, files]) => ({ id, paths: files.map(file => file.path).sort() }))
      .filter(group => group.paths.length > 1).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
    const active = Array.from(groups.values()).flatMap(group => {
      const files = group.filter(file => file.active)
      if (!files.length) return []
      const task = files[0]!.task
      return [files.length === 1 ? task : { ...task, id: identity(task.id), title: 'ID ambiguo: più task attivi', status: '' }]
    })
    const tasks = sortTasks(active, undefined, priorities).map(task => ({ id: task.id, title: task.title, status: task.status }))
    process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'task-list', tasks, conflicts }) + '\n')
    return
  }
  const group = groups.get(identity(id!)) ?? []
  if (group.length > 1) throw new Error(`Ambiguous task ID ${id}: ${group.map(file => file.path).sort().join(', ')}`)
  const record = group[0]
  if (!record?.active) throw new Error(`Task ${id} not found in backlog/tasks`)
  const { task, path } = record
  process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: 'task-view', task: {
    id: task.id, title: task.title, status: task.status, path, description: task.description ?? '',
    dependencies: task.dependencies, acceptanceCriteria: task.acceptanceCriteriaItems ?? [],
    definitionOfDone: task.definitionOfDoneItems ?? [],
  } }) + '\n')
}

main().catch(error => {
  process.stderr.write(`Backlog reader: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
