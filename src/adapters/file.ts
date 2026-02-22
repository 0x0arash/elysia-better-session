import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { JsonObject, SessionStoreAdapter, StoredSession } from '../types.js'

/** Options for the JSON file session adapter. */
export interface FileSessionAdapterOptions {
  /** Absolute or relative path to the JSON backing file. */
  filePath: string
  /** Time source used for expiration checks. */
  now?: () => number
  /** Pretty-print the JSON file with indentation. */
  pretty?: boolean
  /** Deep clone strategy for stored payloads. */
  clone?: <TValue>(value: TValue) => TValue
}

type SessionDictionary<TSession extends JsonObject> = Record<string, StoredSession<TSession>>

const defaultClone = <TValue>(value: TValue): TValue => {
  if (typeof structuredClone === 'function') {
    return structuredClone(value)
  }

  return JSON.parse(JSON.stringify(value)) as TValue
}

const isMissingFileError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error as { code?: string }).code === 'ENOENT'

const removeExpired = <TSession extends JsonObject>(
  sessions: SessionDictionary<TSession>,
  now: number
): { next: SessionDictionary<TSession>; changed: boolean } => {
  const next: SessionDictionary<TSession> = {}
  let changed = false

  for (const [id, stored] of Object.entries(sessions)) {
    if (stored.expiresAt <= now) {
      changed = true
      continue
    }

    next[id] = stored
  }

  if (!changed && Object.keys(next).length !== Object.keys(sessions).length) {
    changed = true
  }

  return { next, changed }
}

/** Session adapter that persists sessions to a JSON file. */
export class FileSessionAdapter<TSession extends JsonObject = JsonObject>
  implements SessionStoreAdapter<TSession>
{
  private readonly filePath: string
  private readonly now: () => number
  private readonly pretty: boolean
  private readonly clone: <TValue>(value: TValue) => TValue
  private operationQueue: Promise<void> = Promise.resolve()

  /** Creates a file-backed adapter instance. */
  constructor(options: FileSessionAdapterOptions) {
    this.filePath = options.filePath
    this.now = options.now ?? Date.now
    this.pretty = options.pretty ?? false
    this.clone = options.clone ?? defaultClone
  }

  private enqueue<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const run = this.operationQueue.then(task, task)
    this.operationQueue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async readStore(): Promise<SessionDictionary<TSession>> {
    try {
      const payload = await readFile(this.filePath, 'utf8')
      if (!payload.trim()) {
        return {}
      }

      return JSON.parse(payload) as SessionDictionary<TSession>
    } catch (error) {
      if (!isMissingFileError(error)) {
        throw error
      }

      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFile(this.filePath, '{}', 'utf8')
      return {}
    }
  }

  private async writeStore(store: SessionDictionary<TSession>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const content = this.pretty ? JSON.stringify(store, null, 2) : JSON.stringify(store)
    await writeFile(this.filePath, content, 'utf8')
  }

  async get(id: string): Promise<StoredSession<TSession> | null> {
    return this.enqueue(async () => {
      const store = await this.readStore()
      const { next, changed } = removeExpired(store, this.now())
      const existing = next[id]

      if (changed) {
        await this.writeStore(next)
      }

      return existing ? this.clone(existing) : null
    })
  }

  async set(id: string, session: StoredSession<TSession>): Promise<void> {
    return this.enqueue(async () => {
      const store = await this.readStore()
      const { next } = removeExpired(store, this.now())
      next[id] = this.clone(session)
      await this.writeStore(next)
    })
  }

  async delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      const store = await this.readStore()
      const { next } = removeExpired(store, this.now())
      delete next[id]
      await this.writeStore(next)
    })
  }
}

/** Creates a JSON file-backed session adapter. */
export const createFileSessionAdapter = <TSession extends JsonObject = JsonObject>(
  options: FileSessionAdapterOptions
): SessionStoreAdapter<TSession> => new FileSessionAdapter<TSession>(options)
