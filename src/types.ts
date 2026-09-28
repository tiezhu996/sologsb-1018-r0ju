export type Intonation = 'fall' | 'rise' | 'flat' | 'rise-fall' | 'fall-rise'
export type StressLevel = 0 | 1 | 2 | 3

export interface SenseGroup {
  id: string
  text: string
  stressWords: string[]
  stressLevel: StressLevel
  pauseMs: number
  intonation: Intonation
  note: string
}

export interface GroupScore {
  groupId: string
  accuracy: number
  rhythm: number
  deviation: number
  note: string
}

export interface WordIssue {
  id: string
  groupId: string
  word: string
  category: string
  note: string
}

export interface SegmentFeedback {
  id: string
  groupId: string
  teacher: string
  text: string
  createdAt: string
}

export interface Attempt {
  id: string
  number: number
  label: string
  createdAt: string
  duration: number
  /** 录音在 IndexedDB audio store 中的键；模拟轮次为 undefined */
  audioKey?: string
  audioMime: string
  simulated: boolean
  /** 有录音索引但音频本体缺失时置位，界面照常展示但标明无法回听 */
  audioMissing?: boolean
  rangeStart: number
  rangeEnd: number
  scores: GroupScore[]
  wordIssues: WordIssue[]
  feedback: SegmentFeedback[]
  selfNote: string
}

export interface PracticeProject {
  title: string
  sentence: string
  translation: string
  teacher: string
  targetAttempts: number
  targetDuration: number
  groups: SenseGroup[]
  attempts: Attempt[]
  errorCategories: string[]
  updatedAt: string
}

/** v2：练习主体只含标注、评分与录音索引，音频单独存放在 audio store */
export interface PersistedPractice {
  project: PracticeProject
  version: 2
}

/** v1：旧整包结构，录音 Blob 与练习主体写在一起 */
export interface LegacyPersistedPractice {
  project: LegacyProject
  version: 1
}

export interface LegacyAttempt extends Omit<Attempt, 'audioKey' | 'audioMissing'> {
  audioBlob?: Blob
}

export interface LegacyProject extends Omit<PracticeProject, 'attempts'> {
  attempts: LegacyAttempt[]
}

export interface AudioRecord {
  blob: Blob
  mime: string
  attemptId: string
  createdAt: string
}
