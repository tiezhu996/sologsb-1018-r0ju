import type {
  AudioRecord,
  LegacyAttempt,
  LegacyPersistedPractice,
  PersistedPractice,
  PracticeProject
} from './types'

type MigratingAttempt = LegacyAttempt & {
  audioKey?: string
  audioMissing?: boolean
}

const DB_NAME = 'sologsb-1018-prosody'
const DB_VERSION = 2
const STORE = 'practice'
const AUDIO_STORE = 'audio'
const KEY = 'current'
const FALLBACK_KEY = 'sologsb-1018-fallback'

export type SaveTarget = 'indexeddb' | 'localstorage'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      // v1 只有 practice 整包 store；v2 新增按轮次独立存放的 audio store。
      // 旧 practice 记录保持原样，由首次 loadPractice 时原子拆分迁移。
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function idbDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function isLegacy(value: PersistedPractice | LegacyPersistedPractice | undefined): value is LegacyPersistedPractice {
  return !!value && value.version === 1
}

/**
 * 旧整包（v1，录音 Blob 内嵌在每轮上）拆到 v2：
 * 练习主体只保留 audioKey 索引，Blob 逐轮写进 audio store。
 * 全部操作在同一个读写事务里提交，任一轮音频写入失败则整笔回滚，
 * 不会留下“主体已拆、音频丢失”的半截结构。
 */
async function migrateLegacy(db: IDBDatabase, legacy: LegacyPersistedPractice): Promise<PracticeProject> {
  const migrated = structuredClone(legacy.project) as unknown as Omit<PracticeProject, 'attempts'> & {
    attempts: MigratingAttempt[]
  }
  const writes: Array<{ key: string; record: AudioRecord }> = []
  migrated.attempts.forEach((attempt) => {
    const blob = attempt.audioBlob
    delete attempt.audioBlob
    if (blob && !attempt.simulated) {
      attempt.audioKey = attempt.id
      attempt.audioMissing = false
      writes.push({
        key: attempt.id,
        record: { blob, mime: attempt.audioMime || blob.type || 'audio/webm', attemptId: attempt.id, createdAt: attempt.createdAt }
      })
    } else {
      attempt.audioKey = undefined
      attempt.audioMissing = false
    }
  })

  // 同键 put 直接覆盖旧整包：主体与全部轮次录音在一个事务里原子落盘。
  const value: PersistedPractice = { project: migrated, version: 2 }
  const transaction = db.transaction([STORE, AUDIO_STORE], 'readwrite')
  transaction.objectStore(STORE).put(value, KEY)
  writes.forEach(({ key, record }) => transaction.objectStore(AUDIO_STORE).put(record, key))
  await idbDone(transaction)
  return migrated
}

/** localStorage 兜底数据可能是 v1 整包（已丢录音）或 v2 主体。 */
function normalizeFallback(raw: string | null): PracticeProject | null {
  if (!raw) return null
  const parsed = JSON.parse(raw) as PersistedPractice | LegacyPersistedPractice | PracticeProject
  const project: PracticeProject | undefined =
    'version' in parsed ? parsed.project as PracticeProject : parsed
  if (!project) return null
  project.attempts.forEach((attempt) => {
    if (attempt.audioKey && !attempt.simulated) attempt.audioMissing = true
  })
  return project
}

/**
 * 读取练习主体。首次打开旧整包时原地拆分到 v2 结构。
 * 返回的主体只含录音索引，音频用 loadAttemptAudio 按轮次懒加载。
 */
export async function loadPractice(): Promise<PracticeProject | null> {
  try {
    const db = await openDb()
    try {
      const transaction = db.transaction(STORE, 'readonly')
      const value = await new Promise<PersistedPractice | LegacyPersistedPractice | undefined>((resolve, reject) => {
        const request = transaction.objectStore(STORE).get(KEY)
        request.onsuccess = () => resolve(request.result as PersistedPractice | LegacyPersistedPractice | undefined)
        request.onerror = () => reject(request.error)
      })
      if (!value) {
        db.close()
        return normalizeFallback(localStorage.getItem(FALLBACK_KEY))
      }
      if (isLegacy(value)) {
        const migrated = await migrateLegacy(db, value)
        db.close()
        return migrated
      }
      db.close()
      return value.project
    } catch (error) {
      db.close()
      throw error
    }
  } catch {
    return normalizeFallback(localStorage.getItem(FALLBACK_KEY))
  }
}

/** 核对每轮录音索引与音频本体是否对得上，返回真正缺音频的轮次 id 集合。 */
export async function listExistingAudioIds(): Promise<Set<string>> {
  const existing = new Set<string>()
  try {
    const db = await openDb()
    const transaction = db.transaction(AUDIO_STORE, 'readonly')
    await new Promise<void>((resolve) => {
      const cursorRequest = transaction.objectStore(AUDIO_STORE).openCursor()
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result
        if (cursor) {
          existing.add(String(cursor.key))
          cursor.continue()
        } else {
          resolve()
        }
      }
      cursorRequest.onerror = () => resolve()
    })
    db.close()
  } catch {
    // 核对失败时按“不缺”处理，避免误标；真正读取时还有一次兜底。
  }
  return existing
}

/** 只写练习主体（标注、评分、错词、反馈与录音索引），不含任何音频 Blob。 */
export async function saveProjectBody(project: PracticeProject): Promise<SaveTarget> {
  const value: PersistedPractice = { project, version: 2 }
  try {
    const db = await openDb()
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(value, KEY)
    await idbDone(transaction)
    db.close()
    return 'indexeddb'
  } catch {
    // 主体很小（不含录音），可安全写入 localStorage；音频仍独立留在 IndexedDB。
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(value))
    return 'localstorage'
  }
}

/**
 * 单独保存一轮录音。失败只影响这一轮：
 * 调用方把该轮标记为 audioMissing，其他轮次与主体不受牵连。
 */
export async function saveAttemptAudio(
  attemptId: string,
  blob: Blob,
  meta: { mime: string; createdAt: string }
): Promise<void> {
  const record: AudioRecord = { blob, mime: meta.mime, attemptId, createdAt: meta.createdAt }
  const db = await openDb()
  try {
    const transaction = db.transaction(AUDIO_STORE, 'readwrite')
    transaction.objectStore(AUDIO_STORE).put(record, attemptId)
    await idbDone(transaction)
  } finally {
    db.close()
  }
}

/** 读取单轮录音；不存在或读取失败返回 null（调用方显示“无法回听”）。 */
export async function loadAttemptAudio(attemptId: string): Promise<AudioRecord | null> {
  try {
    const db = await openDb()
    const transaction = db.transaction(AUDIO_STORE, 'readonly')
    const record = await new Promise<AudioRecord | undefined>((resolve, reject) => {
      const request = transaction.objectStore(AUDIO_STORE).get(attemptId)
      request.onsuccess = () => resolve(request.result as AudioRecord | undefined)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return record ?? null
  } catch {
    return null
  }
}

/** 删除一轮录音；失败不抛出，调用方可重试，绝不阻断主体更新。 */
export async function deleteAttemptAudio(attemptId: string): Promise<void> {
  try {
    const db = await openDb()
    const transaction = db.transaction(AUDIO_STORE, 'readwrite')
    transaction.objectStore(AUDIO_STORE).delete(attemptId)
    await idbDone(transaction)
    db.close()
  } catch {
    // 忽略：残留音频可在下次移除/清理时再删，不影响该轮退出统计。
  }
}

export async function clearPractice(): Promise<void> {
  try {
    const db = await openDb()
    const transaction = db.transaction([STORE, AUDIO_STORE], 'readwrite')
    transaction.objectStore(STORE).clear()
    transaction.objectStore(AUDIO_STORE).clear()
    await idbDone(transaction)
    db.close()
  } catch {
    // Ignore cleanup errors and clear the fallback below.
  }
  localStorage.removeItem(FALLBACK_KEY)
}
