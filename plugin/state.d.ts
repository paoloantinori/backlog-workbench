export interface TaskRow {
  id: string
  title: string
  status: string
}

export interface TaskConflict {
  id: string
  paths: string[]
}

export interface TaskListing {
  tasks: TaskRow[]
  conflicts: TaskConflict[]
}

export interface ChecklistItem {
  text: string
  checked: boolean
}

export interface TaskDetail extends TaskRow {
  description: string
  ac: ChecklistItem[]
  dod: ChecklistItem[]
  dependencies: string[]
  path: string
}

export interface Source {
  root: string
  sessionId: string
}

export type ContextMode = 'short' | 'criteria' | 'full'

export type Prepared = {
  taskId: string
  mode: ContextMode
  review: boolean
  taskRevision: string
  token: number
  gen: number
  root: string
}

export type Attachment =
  | { kind: 'none' }
  | ({ kind: 'prepared' | 'validating' } & Prepared)
  | { kind: 'failed'; reason: string }

export type AppState = {
  sessionKey: string | null
  listGen: number
  detailGen: number
  source: Source | null
  rows: TaskRow[]
  conflicts: TaskConflict[]
  listError: string | null
  pendingList: boolean
  pendingDetail: boolean
  selectedId: string | null
  detail: TaskDetail | null
  detailError: string | null
  query: string
  statusFilter: string | null
  offset: number
  view: 'review' | 'navigator'
  navigatorPage: 'list' | 'detail'
  tab: 'ac' | 'dod'
  contextMode: ContextMode
  tokenSeq: number
  attachment: Attachment
}

declare module 'claude-code' {
  interface PluginState {
    'backlog-workbench': { app: AppState }
  }
}
