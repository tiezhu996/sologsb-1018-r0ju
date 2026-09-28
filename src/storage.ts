import type { Attempt, PersistedPractice, PracticeProject } from './types'

const DB_NAME = 'sologsb-1018-prosody'
const PRACTICE_STORE = 'practice'
const AUDIO_STORE = 'audio'
const KEY = 'current'
const FALLBACK_KEY = 'sologsb-1018-fallback'

interface LegacyAttempt extends Attempt {
  /** v1 结构把录音 Blob 整包塞在尝试里 */
  audioBlob?: Blob
}

interface LegacyPersistedPractice {
  project: PracticeProject
  version?: number
}

export interface LoadResult {
  project: PracticeProject
  /** 本次读取是否把旧整包数据拆到了新结构 */
  migrated: boolean
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PRACTICE_STORE)) db.createObjectStore(PRACTICE_STORE)
      if (!db.objectStoreNames.contains(AUDIO_STORE)) db.createObjectStore(AUDIO_STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function putPractice(db: IDBDatabase, value: PersistedPractice): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(PRACTICE_STORE, 'readwrite')
    transaction.objectStore(PRACTICE_STORE).put(value, KEY)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function stripBlobs(project: PracticeProject): void {
  for (const attempt of project.attempts) delete (attempt as LegacyAttempt).audioBlob
}

/**
 * 旧整包数据拆到新结构：录音逐个写入独立的 audio 存储区，
 * 单轮写不进时只把这一轮标记为无法回听，其他轮次和标注不受影响。
 * 返回是否发生过结构变更。
 */
async function normalizeProject(raw: PracticeProject, legacy: boolean): Promise<{ project: PracticeProject; changed: boolean }> {
  const project = raw
  let changed = legacy
  for (const attempt of project.attempts as LegacyAttempt[]) {
    const blob = attempt.audioBlob
    if (blob instanceof Blob) {
      const ok = await saveAudio(attempt.id, blob)
      delete attempt.audioBlob
      attempt.audioId = attempt.id
      if (!ok) attempt.audioMissing = true
      changed = true
    } else if ('audioBlob' in attempt) {
      delete attempt.audioBlob
      changed = true
    }
    // 旧 localStorage 备份从未保存过录音：非模拟轮保留标注，标明无法回听。
    if (legacy && !attempt.simulated && !attempt.audioId) attempt.audioMissing = true
  }
  return { project, changed }
}

export async function loadPractice(): Promise<LoadResult | null> {
  try {
    const db = await openDb()
    const record = await new Promise<LegacyPersistedPractice | undefined>((resolve, reject) => {
      const transaction = db.transaction(PRACTICE_STORE, 'readonly')
      const request = transaction.objectStore(PRACTICE_STORE).get(KEY)
      request.onsuccess = () => resolve(request.result as LegacyPersistedPractice | undefined)
      request.onerror = () => reject(request.error)
    })
    if (record?.project) {
      const legacy = record.version !== 2
      const { project, changed } = await normalizeProject(record.project, legacy)
      if (changed) {
        try {
          await putPractice(db, { project, version: 2 })
        } catch {
          // 拆包写回失败不影响本次读取，下次打开会再尝试一次。
        }
      }
      db.close()
      return { project, migrated: changed }
    }
    db.close()
  } catch {
    const raw = localStorage.getItem(FALLBACK_KEY)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as PracticeProject
        const { project } = await normalizeProject(parsed, true)
        return { project, migrated: true }
      } catch {
        return null
      }
    }
  }
  return null
}

/** 练习主体只含标注、评分和录音索引，不再夹带任何录音 Blob。 */
export async function savePractice(project: PracticeProject): Promise<'indexeddb' | 'localstorage'> {
  const value: PersistedPractice = { project, version: 2 }
  try {
    const db = await openDb()
    stripBlobs(project)
    await putPractice(db, value)
    db.close()
    return 'indexeddb'
  } catch {
    const fallback: PracticeProject = structuredClone(project)
    stripBlobs(fallback)
    try {
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(fallback))
    } catch {
      // localStorage 也失败（如配额或隐私模式）时放弃这一次写入，内存中的练习仍可继续使用。
    }
    return 'localstorage'
  }
}

/** 单轮录音独立写入；这一轮失败由调用方标记无法回听，不牵连其他轮次。 */
export async function saveAudio(audioId: string, blob: Blob): Promise<boolean> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE, 'readwrite')
      transaction.objectStore(AUDIO_STORE).put(blob, audioId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    db.close()
    return true
  } catch {
    return false
  }
}

export async function loadAudio(audioId: string): Promise<Blob | null> {
  try {
    const db = await openDb()
    const blob = await new Promise<Blob | undefined>((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE, 'readonly')
      const request = transaction.objectStore(AUDIO_STORE).get(audioId)
      request.onsuccess = () => resolve(request.result as Blob | undefined)
      request.onerror = () => reject(request.error)
    })
    db.close()
    return blob ?? null
  } catch {
    return null
  }
}

/** 移除一轮时清掉对应音频；清理失败不影响练习主体的保存。 */
export async function deleteAudio(audioId: string): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE, 'readwrite')
      transaction.objectStore(AUDIO_STORE).delete(audioId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // 音频清理失败不应阻断删除流程。
  }
}

export async function clearPractice(): Promise<void> {
  try {
    const db = await openDb()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction([PRACTICE_STORE, AUDIO_STORE], 'readwrite')
      transaction.objectStore(PRACTICE_STORE).clear()
      transaction.objectStore(AUDIO_STORE).clear()
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
    })
    db.close()
  } catch {
    // Ignore cleanup errors and clear the fallback below.
  }
  localStorage.removeItem(FALLBACK_KEY)
}
