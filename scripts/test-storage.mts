import 'fake-indexeddb/auto'

const memoryStore = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (key: string) => (memoryStore.has(key) ? memoryStore.get(key)! : null),
  setItem: (key: string, value: string) => void memoryStore.set(key, String(value)),
  removeItem: (key: string) => void memoryStore.delete(key),
  clear: () => memoryStore.clear(),
  key: (index: number) => [...memoryStore.keys()][index] ?? null,
  get length() { return memoryStore.size }
} as Storage

import {
  clearPractice,
  deleteAttemptAudio,
  listExistingAudioIds,
  loadAttemptAudio,
  loadPractice,
  saveAttemptAudio,
  saveProjectBody
} from '../src/storage'
import type { LegacyPersistedPractice, PracticeProject } from '../src/types'

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error('❌ FAIL:', msg)
    process.exitCode = 1
  } else {
    console.log('✅', msg)
  }
}

function makeAttempt(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    number: 1,
    label: id,
    createdAt: new Date().toISOString(),
    duration: 3,
    audioMime: 'audio/webm',
    simulated: false,
    rangeStart: 0,
    rangeEnd: 3,
    scores: [],
    wordIssues: [],
    feedback: [],
    selfNote: '',
    ...overrides
  }
}

function makeProject(attempts: unknown[]): PracticeProject {
  return {
    title: 't',
    sentence: 's',
    translation: 'x',
    teacher: 'T',
    targetAttempts: 5,
    targetDuration: 10,
    groups: [],
    attempts: attempts as PracticeProject['attempts'],
    errorCategories: [],
    updatedAt: new Date().toISOString()
  }
}

function deleteDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('sologsb-1018-prosody')
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
    req.onblocked = () => resolve()
  })
}

async function seedV1() {
  // 直接用 IDB v1 结构塞入旧整包：一轮有录音、一轮无录音、一轮模拟。
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('sologsb-1018-prosody', 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('practice')
    }
    req.onsuccess = () => {
      const db = req.result
      const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' })
      const legacy: LegacyPersistedPractice = {
        version: 1,
        project: makeProject([
          makeAttempt('a1', { audioBlob: blob }),
          makeAttempt('a2'),
          makeAttempt('a3', { simulated: true, label: 'sim' })
        ]) as LegacyPersistedPractice['project']
      }
      const tx = db.transaction('practice', 'readwrite')
      tx.objectStore('practice').put(legacy, 'current')
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

async function main() {
  // ---- 1. 旧整包首次打开拆分到新结构 ----
  await clearPractice()
  await deleteDb()
  await seedV1()
  const migrated = await loadPractice()
  assert(migrated !== null, '迁移后返回练习')
  assert(migrated!.attempts[0].audioKey === 'a1', '有录音轮次保留 audioKey 索引')
  assert(!('audioBlob' in migrated!.attempts[0]), '主体不再内嵌 audioBlob')
  assert(migrated!.attempts[1].audioKey === undefined && !migrated!.attempts[1].audioMissing, '无录音轮次无索引、不标缺失')
  assert(migrated!.attempts[2].simulated, '模拟轮次保持 simulated')
  const rec1 = await loadAttemptAudio('a1')
  assert(rec1 !== null && rec1.mime === 'audio/webm', '旧录音可逐轮回读')
  const idsAfterMigration = await listExistingAudioIds()
  assert(idsAfterMigration.has('a1') && !idsAfterMigration.has('a2'), '音频 store 只含实际录音')

  // 再次加载应直接命中 v2，不重复迁移
  const secondLoad = await loadPractice()
  assert(secondLoad !== null && secondLoad.attempts[0].audioKey === 'a1', '再读返回 v2 主体（含录音索引）')
  assert((await listExistingAudioIds()).has('a1'), '再读不清空已拆音频')

  // ---- 2. 新结构：主体保存不含 Blob，音频按轮独立 ----
  await clearPractice()
  const project = makeProject([makeAttempt('b1'), makeAttempt('b2'), makeAttempt('b3', { simulated: true })])
  project.attempts[0].audioKey = 'b1'
  project.attempts[1].audioKey = 'b2'
  const target = await saveProjectBody(project)
  assert(target === 'indexeddb', '主体写入 IndexedDB')
  const blob1 = new Blob([new Uint8Array([9, 9, 9])], { type: 'audio/webm' })
  await saveAttemptAudio('b1', blob1, { mime: 'audio/webm', createdAt: project.attempts[0].createdAt })
  await saveAttemptAudio('b2', new Blob([new Uint8Array([8])], { type: 'audio/webm' }), { mime: 'audio/webm', createdAt: project.attempts[1].createdAt })
  const reloaded = await loadPractice()
  assert(reloaded!.attempts.length === 3, '主体读回三轮')
  assert(reloaded!.attempts.every((a) => !('audioBlob' in a)), '主体各轮都没有 Blob')
  const audio1 = await loadAttemptAudio('b1')
  const audio2 = await loadAttemptAudio('b2')
  assert(audio1 !== null && audio2 !== null, '两轮录音分别可回读')

  // ---- 3. 单轮写入失败只影响这一轮（用不可克隆的值触发真实的写入错误）----
  const realPut = IDBObjectStore.prototype.put
  let failOnce = true
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (failOnce && this.transaction.objectStoreNames.contains('audio')) {
      failOnce = false
      // 函数无法被结构化克隆算法处理，真实触发 DataError / 事务中止。
      return realPut.call(this, { blob: () => 1 }, key)
    }
    return realPut.call(this, value, key)
  }
  let threw = false
  try {
    await saveAttemptAudio('b4', new Blob([new Uint8Array([1])], { type: 'audio/webm' }), { mime: 'audio/webm', createdAt: new Date().toISOString() })
  } catch {
    threw = true
  }
  IDBObjectStore.prototype.put = realPut
  assert(threw, '单轮音频写入失败会 reject')
  assert((await loadAttemptAudio('b1')) !== null && (await loadAttemptAudio('b2')) !== null, '失败不影响其他轮次录音')
  assert((await loadAttemptAudio('b4')) === null, '失败轮次读回为 null（界面标无法回听）')
  const bodyReload = await loadPractice()
  assert(bodyReload !== null && bodyReload.attempts.length === 3, '练习主体与标注照常读回')

  // ---- 4. 删除一轮音频 ----
  await deleteAttemptAudio('b2')
  assert((await loadAttemptAudio('b2')) === null, '删除后该轮音频不存在')
  assert((await loadAttemptAudio('b1')) !== null, '删除不波及其他轮次')

  // ---- 5. localStorage 兜底（v2 主体）标记缺音频 ----
  await clearPractice()
  const fallbackProject = makeProject([makeAttempt('c1'), makeAttempt('c2', { simulated: true })])
  fallbackProject.attempts[0].audioKey = 'c1'
  localStorage.setItem('sologsb-1018-fallback', JSON.stringify({ version: 2, project: fallbackProject }))
  // 让 indexedDB.open 返回一个失败请求，模拟 IndexedDB 不可用，走 localStorage 兜底。
  const realOpen = indexedDB.open.bind(indexedDB)
  indexedDB.open = (() => {
    const target = new EventTarget()
    const fake = {
      set onsuccess(fn: EventListener | null) { target.onmessage = null; if (fn) target.addEventListener('success', fn as EventListener) },
      set onerror(fn: EventListener | null) { if (fn) target.addEventListener('error', fn as EventListener) },
      set onupgradeneeded(_fn: EventListener | null) {},
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: target.dispatchEvent.bind(target)
    } as unknown as IDBOpenDBRequest
    queueMicrotask(() => target.dispatchEvent(new Event('error')))
    return fake
  }) as typeof indexedDB.open
  const fallbackLoaded = await loadPractice()
  indexedDB.open = realOpen
  assert(fallbackLoaded !== null, '兜底返回练习')
  assert(fallbackLoaded!.attempts[0].audioMissing === true, '兜底中真实轮次标为缺音频')
  assert(!fallbackLoaded!.attempts[1].audioMissing, '模拟轮次不标缺音频')

  console.log(process.exitCode ? '\n有失败用例' : '\n全部用例通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
