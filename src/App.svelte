<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { ProgressBar } from '@skeletonlabs/skeleton'
  import { createSampleProject } from './sample'
  import {
    clearPractice,
    deleteAttemptAudio,
    listExistingAudioIds,
    loadAttemptAudio,
    loadPractice,
    saveAttemptAudio,
    saveProjectBody
  } from './storage'
  import type { Attempt, AudioRecord, Intonation, PracticeProject, SenseGroup, StressLevel } from './types'

  const intonationOptions: Array<{ value: Intonation; label: string }> = [
    { value: 'fall', label: '下降 ↘' },
    { value: 'rise', label: '上升 ↗' },
    { value: 'flat', label: '平稳 →' },
    { value: 'rise-fall', label: '先升后降 ↗↘' },
    { value: 'fall-rise', label: '先降后升 ↘↗' }
  ]

  let project: PracticeProject = createSampleProject()
  let loaded = false
  let saveStatus = '正在读取本机练习…'
  let online = true
  let selectedGroupId = project.groups[0]?.id ?? ''
  let selectedAttemptId = project.attempts.at(-1)?.id ?? ''
  let workspaceTab: 'annotate' | 'review' | 'progress' = 'annotate'
  let recording = false
  let recordingSeconds = 0
  let recordingFallback = false
  let mediaRecorder: MediaRecorder | null = null
  let mediaStream: MediaStream | null = null
  let mediaChunks: Blob[] = []
  let recordingTimer: number | undefined
  let saveTimer: number | undefined
  let playbackTimer: number | undefined
  let audioElement: HTMLAudioElement | undefined
  let playing = false
  let playbackTime = 0
  // 每轮音频懒加载缓存：id -> Blob 已加载的播放地址；加载失败 / 缺音频的轮次单独标记。
  let audioCache = new Map<string, string>()
  let audioMissingSet = new Set<string>()
  let audioLoadingId = ''
  let issueWord = ''
  let issueCategory = '声调'
  let issueNote = ''
  let feedbackText = ''
  let newCategory = ''
  interface HistoryEntry {
    project: PracticeProject
    /** 跨越“移除轮次”时携带该轮音频；undo 恢复轮次时把音频写回，redo 移除时再清掉 */
    removedAudio?: Array<{ attemptId: string; blob: Blob; mime: string; createdAt: string }>
  }
  let undoStack: HistoryEntry[] = []
  let redoStack: HistoryEntry[] = []
  let selectedGroup: SenseGroup | undefined
  let selectedAttempt: Attempt | undefined

  $: selectedGroup = project.groups.find((group) => group.id === selectedGroupId) ?? project.groups[0]
  $: selectedAttempt = project.attempts.find((attempt) => attempt.id === selectedAttemptId) ?? project.attempts.at(-1)
  $: selectedScore = selectedAttempt && selectedGroup ? selectedAttempt.scores.find((score) => score.groupId === selectedGroup?.id) : undefined
  $: completedAttempts = Math.min(project.attempts.length, project.targetAttempts)
  $: progress = Math.round((completedAttempts / Math.max(project.targetAttempts, 1)) * 100)
  $: averageAccuracy = selectedAttempt?.scores.length ? Math.round(selectedAttempt.scores.reduce((sum, score) => sum + score.accuracy, 0) / selectedAttempt.scores.length) : 0
  $: averageDeviation = selectedAttempt?.scores.length ? Math.round(selectedAttempt.scores.reduce((sum, score) => sum + score.deviation, 0) / selectedAttempt.scores.length) : 0
  $: totalIssueCategories = project.errorCategories.map((category) => ({ category, count: project.attempts.flatMap((attempt) => attempt.wordIssues).filter((issue) => issue.category === category).length }))

  const clone = <T,>(value: T): T => structuredClone(value)
  const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

  function editProject(mutator: (draft: PracticeProject) => void) {
    const before = clone(project)
    const draft = clone(project)
    mutator(draft)
    draft.updatedAt = new Date().toISOString()
    project = draft
    undoStack = [...undoStack.slice(-59), { project: before }]
    redoStack = []
    scheduleSave()
  }

  function scheduleSave() {
    saveStatus = online ? '正在保存…' : '离线编辑中，稍后继续保存'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(async () => {
      const target = await saveProjectBody(project)
      saveStatus = target === 'indexeddb' ? '已保存到本机' : '已保存到离线备份（标注）'
    }, 250)
  }

  function forgetCachedAudio(attemptId: string) {
    const url = audioCache.get(attemptId)
    if (url) {
      URL.revokeObjectURL(url)
      audioCache.delete(attemptId)
    }
  }

  /** 撤销/重做跨回“移除轮次”时，把该轮音频重新写入独立 audio store。 */
  async function restoreRemovedAudio(entry: HistoryEntry | undefined, target: PracticeProject) {
    if (!entry?.removedAudio?.length) return
    await Promise.all(entry.removedAudio.map(async ({ attemptId, blob, mime, createdAt }) => {
      try {
        await saveAttemptAudio(attemptId, blob, { mime, createdAt })
        audioMissingSet.delete(attemptId)
        forgetCachedAudio(attemptId)
      } catch {
        // 音频写回失败只影响这一轮：轮次已回到列表，标注与评分可读，仅标记无法回听。
        audioMissingSet.add(attemptId)
        forgetCachedAudio(attemptId)
        if (target.attempts.some((attempt) => attempt.id === attemptId)) {
          project = {
            ...target,
            attempts: target.attempts.map((attempt) =>
              attempt.id === attemptId ? { ...attempt, audioMissing: true } : attempt
            )
          }
          void saveProjectBody(project)
        }
      }
    }))
  }

  /** 撤销/重做跨到“移除轮次”时，清掉该轮音频（可能已通过 undo 重新写回）。 */
  async function deleteRemovedAudio(entry: HistoryEntry | undefined) {
    if (!entry?.removedAudio?.length) return
    for (const { attemptId } of entry.removedAudio) {
      audioMissingSet.delete(attemptId)
      forgetCachedAudio(attemptId)
      await deleteAttemptAudio(attemptId)
    }
  }

  function undo() {
    const entry = undoStack.pop()
    if (!entry) return
    redoStack = [...redoStack, { project: clone(project), removedAudio: entry.removedAudio?.map((item) => ({ ...item, blob: clone(item.blob) })) }]
    const target = entry.project
    project = target
    scheduleSave()
    if (entry.removedAudio?.length) void restoreRemovedAudio(entry, target)
  }

  function redo() {
    const entry = redoStack.pop()
    if (!entry) return
    undoStack = [...undoStack, { project: clone(project), removedAudio: entry.removedAudio?.map((item) => ({ ...item, blob: clone(item.blob) })) }]
    project = entry.project
    scheduleSave()
    if (entry.removedAudio?.length) void deleteRemovedAudio(entry)
  }

  function selectGroup(groupId: string) {
    selectedGroupId = groupId
    stopPlayback()
  }

  function updateGroup(field: keyof SenseGroup, value: string | number | string[]) {
    editProject((draft) => {
      const group = draft.groups.find((item) => item.id === selectedGroupId)
      if (!group) return
      ;(group as unknown as Record<string, unknown>)[field] = value
    })
  }

  function setStressLevel(level: number) {
    updateGroup('stressLevel', level as StressLevel)
  }

  function setIntonation(value: string) {
    updateGroup('intonation', value as Intonation)
  }

  function toggleStressWord(word: string) {
    if (!selectedGroup) return
    const words = selectedGroup.stressWords.includes(word) ? selectedGroup.stressWords.filter((item) => item !== word) : [...selectedGroup.stressWords, word]
    updateGroup('stressWords', words)
  }

  function addGroup() {
    const id = uid('group')
    editProject((draft) => {
      draft.groups.push({ id, text: '新的意群', stressWords: [], stressLevel: 1, pauseMs: 300, intonation: 'flat', note: '' })
    })
    selectedGroupId = id
  }

  function deleteGroup() {
    if (!selectedGroup || project.groups.length <= 1) return
    const index = project.groups.findIndex((group) => group.id === selectedGroup.id)
    editProject((draft) => { draft.groups = draft.groups.filter((group) => group.id !== selectedGroup?.id) })
    selectedGroupId = project.groups[Math.max(0, index - 1)]?.id ?? ''
  }

  function moveGroup(direction: -1 | 1) {
    if (!selectedGroup) return
    const index = project.groups.findIndex((group) => group.id === selectedGroup?.id)
    const next = index + direction
    if (next < 0 || next >= project.groups.length) return
    editProject((draft) => {
      const [group] = draft.groups.splice(index, 1)
      draft.groups.splice(next, 0, group)
    })
  }

  function splitSentence() {
    const parts = project.sentence.split(/[，。！？；、\n]+/).map((part) => part.trim()).filter(Boolean)
    if (parts.length < 2) return
    editProject((draft) => {
      draft.groups = parts.map((text, index) => ({
        id: draft.groups[index]?.id ?? uid('group'),
        text,
        stressWords: draft.groups[index]?.stressWords ?? [],
        stressLevel: draft.groups[index]?.stressLevel ?? 1,
        pauseMs: draft.groups[index]?.pauseMs ?? 300,
        intonation: draft.groups[index]?.intonation ?? 'flat',
        note: draft.groups[index]?.note ?? ''
      }))
    })
    selectedGroupId = project.groups[0]?.id ?? ''
  }

  function updateSentence(value: string) {
    editProject((draft) => { draft.sentence = value })
  }

  async function startRecording() {
    if (recording) return
    recordingFallback = false
    mediaChunks = []
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('unsupported')
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      mediaRecorder = new MediaRecorder(mediaStream)
      mediaRecorder.ondataavailable = (event) => { if (event.data.size) mediaChunks.push(event.data) }
      mediaRecorder.onstop = () => finishRecording(recordingFallback)
      mediaRecorder.start()
    } catch {
      recordingFallback = true
      mediaRecorder = null
    }
    recording = true
    recordingSeconds = 0
    window.clearInterval(recordingTimer)
    recordingTimer = window.setInterval(() => { recordingSeconds += 0.1 }, 100)
  }

  function stopRecording() {
    if (!recording) return
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop()
    else finishRecording(true)
  }

  function finishRecording(simulated: boolean) {
    if (!recording) return
    recording = false
    window.clearInterval(recordingTimer)
    mediaStream?.getTracks().forEach((track) => track.stop())
    mediaStream = null
    mediaRecorder = null
    const blob = !simulated && mediaChunks.length ? new Blob(mediaChunks, { type: mediaChunks[0].type || 'audio/webm' }) : undefined
    const attemptId = uid('attempt')
    const number = project.attempts.length + 1
    const duration = Number(Math.max(0.5, recordingSeconds).toFixed(1))
    const createdAt = new Date().toISOString()
    const attempt: Attempt = {
      id: attemptId,
      number,
      label: simulated ? `第 ${number} 轮 · 离线模拟` : `第 ${number} 轮`,
      createdAt,
      duration,
      // 录音与练习主体分开保存：这里只写索引，Blob 在下面单独落盘。
      audioKey: blob ? attemptId : undefined,
      audioMime: blob?.type ?? 'audio/webm',
      simulated,
      audioMissing: false,
      rangeStart: 0,
      rangeEnd: duration,
      scores: project.groups.map((group) => ({ groupId: group.id, accuracy: 70, rhythm: 70, deviation: 0, note: '' })),
      wordIssues: [],
      feedback: [],
      selfNote: ''
    }
    if (blob) audioCache.set(attemptId, URL.createObjectURL(blob))
    editProject((draft) => { draft.attempts.push(attempt) })
    selectedAttemptId = attemptId
    workspaceTab = 'review'
    recordingSeconds = duration
    if (blob) void persistRecordingAudio(attemptId, blob, createdAt)
  }

  // 单轮录音独立写入：失败只影响这一轮，其他录音与标注仍可读回。
  async function persistRecordingAudio(attemptId: string, blob: Blob, createdAt: string) {
    try {
      await saveAttemptAudio(attemptId, blob, { mime: blob.type || 'audio/webm', createdAt })
      saveStatus = '录音与标注已保存到本机'
    } catch {
      audioMissingSet.add(attemptId)
      // 未落盘的内存录音不再保留播放地址，保证界面状态与持久化结果一致（刷新本就会丢）。
      forgetCachedAudio(attemptId)
      project = {
        ...project,
        attempts: project.attempts.map((item) => (item.id === attemptId ? { ...item, audioMissing: true } : item))
      }
      const target = await saveProjectBody(project)
      saveStatus = target === 'indexeddb'
        ? '本轮录音写入失败，标注已保存；该轮暂无法回听'
        : '本轮录音与离线写入失败，标注已存入备份；该轮暂无法回听'
    }
  }

  function isAudioMissing(attempt?: Attempt) {
    if (!attempt || attempt.simulated || !attempt.audioKey) return false
    return !!attempt.audioMissing || audioMissingSet.has(attempt.id)
  }

  // 选中某轮时懒加载它的音频；其他轮次不占内存，读不到就标明无法回听。
  $: if (selectedAttempt?.audioKey && !selectedAttempt.simulated && !selectedAttempt.audioMissing && !audioMissingSet.has(selectedAttempt.id) && !audioCache.has(selectedAttempt.id) && audioLoadingId !== selectedAttempt.id && loaded) {
    void ensureAttemptAudio(selectedAttempt.id)
  }

  async function ensureAttemptAudio(attemptId: string) {
    if (audioLoadingId === attemptId) return
    audioLoadingId = attemptId
    const record: AudioRecord | null = await loadAttemptAudio(attemptId)
    if (record) {
      if (!audioCache.has(attemptId)) audioCache.set(attemptId, URL.createObjectURL(record.blob))
      audioMissingSet.delete(attemptId)
      if (project.attempts.some((attempt) => attempt.id === attemptId && attempt.audioMissing)) {
        project = {
          ...project,
          attempts: project.attempts.map((attempt) =>
            attempt.id === attemptId ? { ...attempt, audioMissing: false } : attempt
          )
        }
      }
    } else {
      audioMissingSet.add(attemptId)
    }
    audioLoadingId = ''
  }

  $: selectedAudioUrl = selectedAttempt && !isAudioMissing(selectedAttempt) ? audioCache.get(selectedAttempt.id) ?? '' : ''

  function audioKindLabel(attempt: Attempt): string {
    if (attempt.simulated) return '模拟'
    if (isAudioMissing(attempt)) return '录音缺失·无法回听'
    return '录音'
  }

  function togglePlayback() {
    if (!selectedAttempt) return
    if (playing) {
      stopPlayback()
      return
    }
    // 模拟轮次没有音频，沿用时间轴模拟播放；缺音频的真实轮次不允许播放。
    if (isAudioMissing(selectedAttempt)) return
    playing = true
    playbackTime = selectedAttempt.rangeStart
    const url = selectedAudioUrl
    if (url && audioElement) {
      audioElement.src = url
      audioElement.currentTime = selectedAttempt.rangeStart
      audioElement.play().catch(() => startPlaybackTimer())
    } else {
      startPlaybackTimer()
    }
  }

  function startPlaybackTimer() {
    window.clearInterval(playbackTimer)
    playbackTimer = window.setInterval(() => {
      playbackTime = Number((playbackTime + 0.1).toFixed(1))
      if (playbackTime >= (selectedAttempt?.rangeEnd ?? 0)) stopPlayback()
    }, 100)
  }

  function stopPlayback() {
    playing = false
    window.clearInterval(playbackTimer)
    audioElement?.pause()
  }

  function onAudioTimeUpdate() {
    if (!audioElement || !selectedAttempt) return
    playbackTime = audioElement.currentTime
    if (playbackTime >= selectedAttempt.rangeEnd) stopPlayback()
  }

  function updateScore(field: 'accuracy' | 'rhythm' | 'deviation', value: number) {
    if (!selectedAttempt || !selectedGroup) return
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      let score = attempt?.scores.find((item) => item.groupId === selectedGroupId)
      if (!attempt || !score) {
        attempt?.scores.push({ groupId: selectedGroupId, accuracy: 70, rhythm: 70, deviation: 0, note: '' })
        score = attempt?.scores.at(-1)
      }
      if (score) score[field] = value
    })
  }

  function updateScoreNote(value: string) {
    if (!selectedAttempt || !selectedGroup) return
    editProject((draft) => {
      const score = draft.attempts.find((attempt) => attempt.id === selectedAttemptId)?.scores.find((item) => item.groupId === selectedGroupId)
      if (score) score.note = value
    })
  }

  function addWordIssue() {
    if (!selectedAttempt || !selectedGroup || !issueWord.trim()) return
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      attempt?.wordIssues.push({ id: uid('issue'), groupId: selectedGroupId, word: issueWord.trim(), category: issueCategory, note: issueNote.trim() })
    })
    issueWord = ''
    issueNote = ''
  }

  function removeWordIssue(issueId: string) {
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      if (attempt) attempt.wordIssues = attempt.wordIssues.filter((issue) => issue.id !== issueId)
    })
  }

  function addFeedback() {
    if (!selectedGroup || !feedbackText.trim()) return
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      attempt?.feedback.push({
        id: uid('feedback'),
        groupId: selectedGroupId,
        teacher: draft.teacher,
        text: feedbackText.trim(),
        createdAt: new Date().toISOString()
      })
    })
    feedbackText = ''
  }

  function updateRange(field: 'rangeStart' | 'rangeEnd', value: number) {
    if (!selectedAttempt) return
    editProject((draft) => {
      const attempt = draft.attempts.find((item) => item.id === selectedAttemptId)
      if (!attempt) return
      attempt[field] = value
      if (attempt.rangeEnd <= attempt.rangeStart) {
        if (field === 'rangeStart') attempt.rangeEnd = Math.min(attempt.duration, value + 0.5)
        else attempt.rangeStart = Math.max(0, value - 0.5)
      }
    })
  }

  // 移除一轮：练习主体去掉该轮（评分、错词、反馈随之退出统计），音频单独清除。
  // 音频与轮次数据一起进入撤销栈，撤销时整轮连同录音一起回来。
  async function removeAttempt() {
    const attempt = selectedAttempt
    if (!attempt) return
    if (!confirm(`确定移除「${attempt.label}」吗？该轮录音、评分与反馈将退出统计，可在撤销后一起恢复。`)) return
    stopPlayback()
    const index = project.attempts.findIndex((item) => item.id === attempt.id)
    // 撤销时需要把录音写回，先把这轮 Blob 取进撤销栈；取不到也允许撤销恢复主体（仅无法回听）。
    let record: AudioRecord | null = null
    if (attempt.audioKey && !attempt.simulated && !isAudioMissing(attempt)) {
      record = await loadAttemptAudio(attempt.id)
    }
    const removedAudio = record ? [{ attemptId: attempt.id, blob: record.blob, mime: record.mime, createdAt: attempt.createdAt }] : undefined
    const before = clone(project)
    const draft = clone(project)
    draft.attempts = draft.attempts.filter((item) => item.id !== attempt.id)
    draft.updatedAt = new Date().toISOString()
    project = draft
    undoStack = [...undoStack.slice(-59), { project: before, removedAudio }]
    redoStack = []
    scheduleSave()
    forgetCachedAudio(attempt.id)
    audioMissingSet.delete(attempt.id)
    await deleteAttemptAudio(attempt.id)
    const next = project.attempts[index] ?? project.attempts[index - 1]
    selectedAttemptId = next?.id ?? ''
  }

  function addCategory() {
    if (!newCategory.trim() || project.errorCategories.includes(newCategory.trim())) return
    editProject((draft) => { draft.errorCategories.push(newCategory.trim()) })
    newCategory = ''
  }

  function resetSample() {
    if (!confirm('恢复示例会替换当前练习，确定继续吗？')) return
    const oldAttemptIds = project.attempts.map((attempt) => attempt.id)
    const sample = createSampleProject()
    // 示例轮次没有真实音频，统一标为无法回听。
    sample.attempts = sample.attempts.map((attempt) =>
      attempt.simulated ? attempt : { ...attempt, audioKey: undefined, audioMissing: true }
    )
    editProject((draft) => { Object.assign(draft, clone(sample)) })
    oldAttemptIds.forEach(forgetCachedAudio)
    audioMissingSet.clear()
    void Promise.all(oldAttemptIds.map(deleteAttemptAudio))
    selectedGroupId = project.groups[0]?.id ?? ''
    selectedAttemptId = project.attempts.at(-1)?.id ?? ''
  }

  async function deleteAllData() {
    if (!confirm('这会清除本机全部练习、录音与反馈，且不能撤销。')) return
    stopPlayback()
    await clearPractice()
    audioCache.forEach((url) => URL.revokeObjectURL(url))
    audioCache = new Map()
    audioMissingSet.clear()
    const sample = createSampleProject()
    sample.attempts = sample.attempts.map((attempt) =>
      attempt.simulated ? attempt : { ...attempt, audioKey: undefined, audioMissing: true }
    )
    project = sample
    selectedGroupId = sample.groups[0]?.id ?? ''
    selectedAttemptId = sample.attempts.at(-1)?.id ?? ''
    undoStack = []
    redoStack = []
    await saveProjectBody(project)
  }

  function onKeydown(event: KeyboardEvent) {
    const command = event.ctrlKey || event.metaKey
    if (command && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void saveProjectBody(project).then((target) => { saveStatus = target === 'indexeddb' ? '已保存到本机' : '已保存到离线备份（标注）' })
    } else if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      event.shiftKey ? redo() : undo()
    } else if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      redo()
    } else if (event.altKey && event.key.toLowerCase() === 'r') {
      event.preventDefault()
      recording ? stopRecording() : void startRecording()
    } else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault()
      moveGroup(event.key === 'ArrowUp' ? -1 : 1)
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return
      const index = project.groups.findIndex((group) => group.id === selectedGroupId)
      const next = index + (event.key === 'ArrowLeft' ? -1 : 1)
      if (project.groups[next]) selectedGroupId = project.groups[next].id
    }
  }

  onMount(async () => {
    online = navigator.onLine
    const saved = await loadPractice()
    if (saved) project = saved
    // 示例轮次没有真实音频；旧整包迁移或兜底恢复后也核对一遍索引与音频本体。
    const existing = await listExistingAudioIds()
    let missingChanged = false
    project.attempts = project.attempts.map((attempt) => {
      if (attempt.simulated || !attempt.audioKey) {
        if (attempt.audioMissing) {
          missingChanged = true
          return { ...attempt, audioMissing: false }
        }
        return attempt
      }
      const hasAudio = existing.has(attempt.id)
      if (hasAudio) {
        if (attempt.audioMissing) {
          missingChanged = true
          return { ...attempt, audioMissing: false }
        }
        return attempt
      }
      if (!attempt.audioMissing) missingChanged = true
      return { ...attempt, audioMissing: true }
    })
    if (!saved) {
      // 首次使用：示例本身也无音频，直接落一份主体，避免后续把缺失标成脏数据。
      await saveProjectBody(project)
    } else if (missingChanged) {
      await saveProjectBody(project)
    }
    selectedGroupId = project.groups[0]?.id ?? ''
    selectedAttemptId = project.attempts.at(-1)?.id ?? ''
    loaded = true
    saveStatus = saved ? '已恢复本机练习' : '示例练习已就绪'
    window.addEventListener('online', () => { online = true })
    window.addEventListener('offline', () => { online = false })
    window.addEventListener('keydown', onKeydown)
  })

  onDestroy(() => {
    window.clearTimeout(saveTimer)
    window.clearInterval(recordingTimer)
    window.clearInterval(playbackTimer)
    mediaStream?.getTracks().forEach((track) => track.stop())
    audioCache.forEach((url) => URL.revokeObjectURL(url))
    window.removeEventListener('keydown', onKeydown)
  })
</script>

<svelte:head>
  <title>{project.title} · 声律场</title>
</svelte:head>

<div class="app-shell min-h-screen">
  <header class="top-header">
    <div class="brand-block">
      <div class="brand-mark">律</div>
      <div>
        <strong>声律场</strong>
        <span>PROSODY PRACTICE</span>
      </div>
    </div>
    <div class="practice-title">
      <h1>{project.title}</h1>
      <span>{project.teacher} · 手机与电脑自动适配</span>
    </div>
    <div class="header-actions">
      <span class:offline={!online} class="connection badge">{online ? '在线' : '离线编辑'}</span>
      <span class="save-state">{saveStatus}</span>
      <button class="btn btn-sm variant-ghost" on:click={undo} disabled={!undoStack.length}>撤销</button>
      <button class="btn btn-sm variant-ghost" on:click={redo} disabled={!redoStack.length}>重做</button>
      <button class="btn btn-sm variant-ghost" on:click={resetSample}>恢复示例</button>
    </div>
  </header>

  <section class="progress-strip">
    <div class="progress-copy">
      <span>练习进度</span>
      <strong>{completedAttempts} / {project.targetAttempts} 轮</strong>
    </div>
    <ProgressBar value={progress} />
    <div class="progress-metric"><span>当前准确度</span><strong>{averageAccuracy}%</strong></div>
    <div class="progress-metric"><span>平均偏差</span><strong>{averageDeviation}%</strong></div>
    <div class="progress-metric"><span>目标时长</span><strong>{project.targetDuration.toFixed(1)}s</strong></div>
  </section>

  <div class="mobile-tabs">
    <button class:active={workspaceTab === 'annotate'} on:click={() => workspaceTab = 'annotate'}>标注</button>
    <button class:active={workspaceTab === 'review'} on:click={() => workspaceTab = 'review'}>录音校对</button>
    <button class:active={workspaceTab === 'progress'} on:click={() => workspaceTab = 'progress'}>反馈进度</button>
  </div>

  <main class="workspace">
    <aside class:mobile-hidden={workspaceTab !== 'annotate'} class="group-column card">
      <div class="section-heading">
        <div><span class="eyebrow">TEXT</span><h2>原文与意群</h2></div>
        <button class="btn btn-sm variant-soft-primary" on:click={addGroup}>＋ 意群</button>
      </div>
      <label class="label">
        <span>录入句子</span>
        <textarea class="textarea" rows="4" value={project.sentence} on:input={(event) => updateSentence(event.currentTarget.value)}></textarea>
      </label>
      <label class="label">
        <span>英文释义 / 参考</span>
        <textarea class="textarea" rows="3" value={project.translation} on:input={(event) => editProject((draft) => draft.translation = event.currentTarget.value)}></textarea>
      </label>
      <div class="inline-actions">
        <button class="btn btn-sm variant-soft" on:click={splitSentence}>按标点智能切分</button>
        <span>{project.groups.length} 个意群</span>
      </div>
      <div class="group-list">
        {#each project.groups as group, index (group.id)}
          <button class:active={group.id === selectedGroup?.id} class="group-item" on:click={() => selectGroup(group.id)}>
            <span class="group-index">{String(index + 1).padStart(2, '0')}</span>
            <span class="group-copy">
              <strong>{group.text}</strong>
              <small>重音 {group.stressWords.join('、') || '未设'} · 停 {group.pauseMs}ms · {intonationOptions.find((item) => item.value === group.intonation)?.label}</small>
            </span>
          </button>
        {/each}
      </div>
      <div class="sidebar-actions">
        <button class="btn btn-sm variant-ghost" on:click={() => moveGroup(-1)}>上移</button>
        <button class="btn btn-sm variant-ghost" on:click={() => moveGroup(1)}>下移</button>
        <button class="btn btn-sm variant-ghost text-error-500" on:click={deleteGroup}>删除意群</button>
      </div>
      <div class="shortcut-note">
        <strong>快捷操作</strong>
        <span>Alt + ↑/↓ 调整意群 · Alt+R 开始/停止录音</span>
        <span>← / → 切换意群 · ⌘S 保存 · ⌘Z 撤销</span>
      </div>
    </aside>

    {#if selectedGroup}
      <section class:mobile-hidden={workspaceTab !== 'annotate'} class="annotation-column">
        <div class="card annotation-card">
          <div class="section-heading">
            <div><span class="eyebrow">PROSODY MARKUP</span><h2>发音与韵律标注</h2></div>
            <span class="chapter-badge">意群 {project.groups.findIndex((group) => group.id === selectedGroup?.id) + 1}</span>
          </div>
          <label class="label">
            <span>意群文本</span>
            <input class="input" value={selectedGroup.text} on:input={(event) => updateGroup('text', event.currentTarget.value)} />
          </label>
          <div class="token-board">
            <div class="token-label">点击文字切换重音词</div>
            <div class="token-list">
              {#each selectedGroup.text.split('') as char}
                <button class:stressed={selectedGroup.stressWords.some((word) => word.includes(char))} class="text-token" on:click={() => toggleStressWord(char)}>{char}</button>
              {/each}
            </div>
          </div>
          <div class="annotation-grid">
            <label class="label">
              <span>重音词（用逗号分隔）</span>
              <input class="input" value={selectedGroup.stressWords.join('，')} on:change={(event) => updateGroup('stressWords', event.currentTarget.value.split(/[，,]/).map((word) => word.trim()).filter(Boolean))} />
            </label>
            <div class="label">
              <span>重音强度</span>
              <div class="segmented">
                {#each [0, 1, 2, 3] as level}
                  <button class:active={selectedGroup.stressLevel === level} on:click={() => setStressLevel(level)}>{level === 0 ? '无' : '●'.repeat(level)}</button>
                {/each}
              </div>
            </div>
            <label class="label">
              <span>后接停顿：{selectedGroup.pauseMs}ms</span>
              <input class="range" type="range" min="0" max="1500" step="20" value={selectedGroup.pauseMs} on:input={(event) => updateGroup('pauseMs', Number(event.currentTarget.value))} />
            </label>
            <label class="label">
              <span>语调走向</span>
              <select class="select" value={selectedGroup.intonation} on:change={(event) => setIntonation(event.currentTarget.value)}>
                {#each intonationOptions as option}<option value={option.value}>{option.label}</option>{/each}
              </select>
            </label>
            <label class="label span-2">
              <span>学习提示</span>
              <input class="input" value={selectedGroup.note} on:input={(event) => updateGroup('note', event.currentTarget.value)} placeholder="例如：重音后短停，句尾自然下落" />
            </label>
          </div>
          <div class="prosody-preview">
            <div>
              <span class="eyebrow">PREVIEW</span>
              <strong>标注预览</strong>
            </div>
            <p>
              <span class="stress-line">{'●'.repeat(selectedGroup.stressLevel)}</span>
              <span>{selectedGroup.text}</span>
              <span class="pause-mark">{selectedGroup.pauseMs ? `／ ${selectedGroup.pauseMs}ms` : ''}</span>
              <span class="intonation-mark">{intonationOptions.find((item) => item.value === selectedGroup.intonation)?.label}</span>
            </p>
          </div>
        </div>

        <div class="card recorder-card">
          <div class="section-heading">
            <div><span class="eyebrow">RECORDING</span><h2>录下这一轮</h2></div>
            <span class:recording class="record-dot">{recording ? 'REC' : 'READY'}</span>
          </div>
          <div class="record-console">
            <div class="record-time">{Math.floor(recordingSeconds / 60).toString().padStart(2, '0')}:{Math.floor(recordingSeconds % 60).toString().padStart(2, '0')}.{Math.floor((recordingSeconds % 1) * 10)}</div>
            <div class="level-bars" aria-hidden="true">
              {#each Array(24) as _, index}<span style={`height:${recording ? 18 + ((index * 17) % 46) : 12}%`}></span>{/each}
            </div>
            <button class:variant-filled-error={recording} class:variant-filled-primary={!recording} class="btn record-button" on:click={() => recording ? stopRecording() : startRecording()}>
              {recording ? '■ 停止并保存尝试' : '● 开始录音'}
            </button>
            <p>{recordingFallback ? '当前浏览器未授权麦克风，将保存一轮可校对的离线模拟记录。' : '录音按轮次单独保存在本机 IndexedDB，不会上传；单轮写入失败只影响这一轮，其他录音与标注仍可读回。'}</p>
          </div>
        </div>
      </section>
    {/if}

    <aside class:mobile-hidden={workspaceTab !== 'review' && workspaceTab !== 'progress'} class="review-column">
      <div class="card attempts-card">
        <div class="section-heading">
          <div><span class="eyebrow">TAKES</span><h2>多轮尝试</h2></div>
          <span class="chapter-badge">{project.attempts.length} 轮</span>
        </div>
        <div class="attempt-list">
          {#each [...project.attempts].reverse() as attempt}
            <div class:active={attempt.id === selectedAttempt?.id} class="attempt-item">
              <button class="attempt-select" on:click={() => { selectedAttemptId = attempt.id; stopPlayback() }}>
                <span class="attempt-number">{attempt.number}</span>
                <span><strong>{attempt.label}</strong><small>{attempt.duration.toFixed(1)}s · {audioKindLabel(attempt)}</small></span>
                <span class="attempt-score">{attempt.scores.length ? Math.round(attempt.scores.reduce((sum, score) => sum + score.accuracy, 0) / attempt.scores.length) : 0}%</span>
              </button>
              <button class="attempt-remove" title="移除这一轮（可撤销）" on:click={() => { selectedAttemptId = attempt.id; void removeAttempt() }}>✕</button>
            </div>
          {/each}
          {#if !project.attempts.length}<p class="empty-copy">还没有练习轮次，去录下第一轮吧。</p>{/if}
        </div>
      </div>

      {#if selectedAttempt}
        <div class:recommended={workspaceTab !== 'progress'} class="card playback-card">
          <div class="section-heading">
            <div><span class="eyebrow">COMPARE</span><h2>回听与偏差</h2></div>
            {#if isAudioMissing(selectedAttempt)}
              <span class="btn btn-sm" aria-disabled="true">🔇 无法回听</span>
            {:else if audioLoadingId === selectedAttempt.id}
              <span class="btn btn-sm">音频读取中…</span>
            {:else}
              <button class="btn btn-sm variant-filled-primary" on:click={togglePlayback}>{playing ? '■ 停止' : '▶ 播放范围'}</button>
            {/if}
          </div>
          {#if isAudioMissing(selectedAttempt)}
            <p class="audio-missing-note">这一轮的录音索引还在（评分、错词与反馈可照常查看），但本机音频本体缺失，暂时无法回听；可保留标注继续练习。</p>
          {/if}
          {#if !isAudioMissing(selectedAttempt)}
            <audio bind:this={audioElement} src={selectedAudioUrl} on:timeupdate={onAudioTimeUpdate} on:ended={stopPlayback}></audio>
          {/if}
          <div class="playback-timeline">
            <div class="playhead" style={`left:${selectedAttempt.duration ? Math.min(100, playbackTime / selectedAttempt.duration * 100) : 0}%`}></div>
            <span class="range-fill" style={`left:${selectedAttempt.duration ? selectedAttempt.rangeStart / selectedAttempt.duration * 100 : 0}%;right:${selectedAttempt.duration ? 100 - selectedAttempt.rangeEnd / selectedAttempt.duration * 100 : 0}%`}></span>
          </div>
          <div class="range-controls">
            <label><span>回听起点 {selectedAttempt.rangeStart.toFixed(1)}s</span><input class="range" type="range" min="0" max={selectedAttempt.duration} step="0.1" value={selectedAttempt.rangeStart} on:input={(event) => updateRange('rangeStart', Number(event.currentTarget.value))} /></label>
            <label><span>回听终点 {selectedAttempt.rangeEnd.toFixed(1)}s</span><input class="range" type="range" min="0" max={selectedAttempt.duration} step="0.1" value={selectedAttempt.rangeEnd} on:input={(event) => updateRange('rangeEnd', Number(event.currentTarget.value))} /></label>
          </div>
          {#if selectedScore}
            <div class="score-grid">
              <label><span>准确度 {selectedScore.accuracy}%</span><input class="range" type="range" min="0" max="100" value={selectedScore.accuracy} on:input={(event) => updateScore('accuracy', Number(event.currentTarget.value))} /></label>
              <label><span>节奏 {selectedScore.rhythm}%</span><input class="range" type="range" min="0" max="100" value={selectedScore.rhythm} on:input={(event) => updateScore('rhythm', Number(event.currentTarget.value))} /></label>
              <label><span>偏差 {selectedScore.deviation}%</span><input class="range" type="range" min="0" max="100" value={selectedScore.deviation} on:input={(event) => updateScore('deviation', Number(event.currentTarget.value))} /></label>
            </div>
            <label class="label"><span>本意群偏差说明</span><textarea class="textarea" rows="2" value={selectedScore.note} on:input={(event) => updateScoreNote(event.currentTarget.value)}></textarea></label>
          {/if}
          <label class="label"><span>本轮自评</span><textarea class="textarea" rows="2" value={selectedAttempt.selfNote} on:input={(event) => editProject((draft) => { const attempt = draft.attempts.find((item) => item.id === selectedAttemptId); if (attempt) attempt.selfNote = event.currentTarget.value })}></textarea></label>
        </div>

        <div class:recommended={workspaceTab === 'review'} class="card issues-card">
          <div class="section-heading">
            <div><span class="eyebrow">ERROR TAGS</span><h2>错词分类</h2></div>
          </div>
          <div class="issue-form">
            <input class="input" placeholder="错词或字" value={issueWord} on:input={(event) => issueWord = event.currentTarget.value} />
            <select class="select" value={issueCategory} on:change={(event) => issueCategory = event.currentTarget.value}>
              {#each project.errorCategories as category}<option value={category}>{category}</option>{/each}
            </select>
            <input class="input span-2" placeholder="问题说明（可选）" value={issueNote} on:input={(event) => issueNote = event.currentTarget.value} />
            <button class="btn btn-sm variant-filled-secondary span-2" on:click={addWordIssue}>添加错词记录</button>
          </div>
          <div class="issue-list">
            {#each selectedAttempt.wordIssues.filter((issue) => issue.groupId === selectedGroupId) as issue}
              <div class="issue-item">
                <span class="badge variant-filled-warning">{issue.category}</span>
                <strong>{issue.word}</strong>
                <p>{issue.note || '暂无补充说明'}</p>
                <button class="btn btn-sm variant-ghost text-error-500" on:click={() => removeWordIssue(issue.id)}>移除</button>
              </div>
            {/each}
            {#if !selectedAttempt.wordIssues.some((issue) => issue.groupId === selectedGroupId)}<p class="empty-copy">本轮意群还没有错词记录。</p>{/if}
          </div>
        </div>
      {/if}

      <div class:recommended={workspaceTab === 'progress'} class="card feedback-card">
        <div class="section-heading">
          <div><span class="eyebrow">TEACHER FEEDBACK</span><h2>逐段反馈</h2></div>
        </div>
        <div class="feedback-list">
          {#each selectedAttempt?.feedback.filter((item) => item.groupId === selectedGroupId) ?? [] as feedback}
            <div class="feedback-item">
              <strong>{feedback.teacher}</strong>
              <p>{feedback.text}</p>
              <small>{new Date(feedback.createdAt).toLocaleString('zh-CN')}</small>
            </div>
          {/each}
        </div>
        <label class="label"><span>给当前意群留言</span><textarea class="textarea" rows="2" value={feedbackText} on:input={(event) => feedbackText = event.currentTarget.value} placeholder="教师反馈会绑定到这一轮和这个意群"></textarea></label>
        <button class="btn btn-sm variant-filled-tertiary" on:click={addFeedback}>留下反馈</button>
      </div>
    </aside>

    {#if workspaceTab === 'progress'}
      <section class="progress-dashboard card">
        <div class="section-heading">
          <div><span class="eyebrow">PROGRESS</span><h2>练习进度与错词归类</h2></div>
        </div>
        <div class="progress-grid">
          <div><strong>{project.attempts.length}</strong><span>累计尝试</span></div>
          <div><strong>{averageAccuracy}%</strong><span>当前准确度</span></div>
          <div><strong>{averageDeviation}%</strong><span>平均偏差</span></div>
          <div><strong>{project.errorCategories.reduce((sum, category) => sum + project.attempts.flatMap((attempt) => attempt.wordIssues).filter((issue) => issue.category === category).length, 0)}</strong><span>错词记录</span></div>
        </div>
        <div class="category-list">
          {#each totalIssueCategories as category}
            <div><span>{category.category}</span><div class="mini-bar"><i style={`width:${Math.min(100, category.count * 18)}%`}></i></div><strong>{category.count}</strong></div>
          {/each}
        </div>
        <div class="inline-actions">
          <input class="input" bind:value={newCategory} placeholder="新增错词分类" />
          <button class="btn btn-sm variant-soft" on:click={addCategory}>添加分类</button>
          <button class="btn btn-sm variant-ghost text-error-500" on:click={deleteAllData}>清除本机数据</button>
        </div>
      </section>
    {/if}
  </main>

  {#if !loaded}
    <div class="loading-overlay"><span class="loading-bar">正在恢复离线练习…</span></div>
  {/if}
</div>
