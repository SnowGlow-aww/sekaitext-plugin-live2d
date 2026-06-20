<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowLeft, Play, Pause, SkipForward, SkipBack } from 'lucide-vue-next'
import Live2DStage from './Live2DStage.vue'
import { useStoryStore, StoryNavigator as getStoryNavigator } from '../host'

const router = useRouter()
const story = useStoryStore()
// Shared core component, provided by the host bridge.
const StoryNavigator = getStoryNavigator()

const stageRef = ref<InstanceType<typeof Live2DStage> | null>(null)
const autoPlay = ref(false)
const voiceVolume = ref(1)
const bgmVolume = ref(0.6)
const status = ref('')
const progress = ref({ current: 0, total: 0 })
const paused = ref(false)
const active = ref(false) // a story is loaded and not yet ended

// Identity of the currently-selected story; if it changes vs what's loaded, the
// main button loads the new one instead of resuming the old.
const selKey = computed(() =>
  `${story.selectedType}|${story.selectedSort}|${story.selectedIndex}|${story.selectedChapter}`)
const loadedKey = ref('')

function playSelected() {
  if (!story.selectedType || story.selectedChapter < 0) {
    status.value = '请先选择剧情类型和章节'
    return
  }
  status.value = '加载中...'
  loadedKey.value = selKey.value
  stageRef.value?.play(
    story.selectedType,
    story.selectedSort,
    story.selectedIndex,
    story.selectedChapter,
  )
}

// Single media-player play/pause button: load a fresh story when nothing is
// active (or the selection changed), otherwise toggle pause/resume.
function mainAction() {
  if (!active.value || selKey.value !== loadedKey.value) playSelected()
  else stageRef.value?.togglePause()
}
// Show Pause only while actively playing (loaded, not paused); otherwise Play.
const mainIsPause = computed(() => active.value && !paused.value && selKey.value === loadedKey.value)
// Tooltip reflects the actual action: pause / resume same story / load (new or fresh).
const mainTitle = computed(() =>
  mainIsPause.value ? '暂停'
  : (active.value && paused.value && selKey.value === loadedKey.value) ? '继续'
  : '播放')
const canStep = computed(() => active.value && !paused.value && !autoPlay.value)

function onLoaded() { status.value = '播放中'; active.value = true }
function onError(msg: string) { status.value = '失败: ' + msg; active.value = false }
function onEnded() { status.value = '剧情结束'; active.value = false }
function onProgress(c: number, t: number) { progress.value = { current: c, total: t } }
function onPauseChange(p: boolean) {
  paused.value = p
  if (status.value === '播放中' || status.value === '已暂停') status.value = p ? '已暂停' : '播放中'
}

// Jump to a specific dialog line via the progress input.
const jumpInput = ref<number | null>(null)
function jumpToLine() {
  const total = progress.value.total
  if (!total || jumpInput.value == null) return
  const line = Math.max(1, Math.min(Math.round(jumpInput.value), total))
  stageRef.value?.seekToLine(line)
  jumpInput.value = null
}

watch([voiceVolume, bgmVolume], ([v, b]) => stageRef.value?.setVolumes(v, b))
</script>

<template>
  <div class="h-screen flex flex-col bg-base-100">
    <header class="border-b border-base-300 px-4 py-2 flex items-center gap-3 shrink-0 flex-wrap">
      <button @click="router.push('/')" class="btn btn-ghost btn-sm gap-1.5">
        <ArrowLeft :size="18" /> 返回
      </button>
      <span class="text-sm font-medium shrink-0">Live2D 播放器</span>
      <div class="flex-1 min-w-0"><StoryNavigator /></div>
    </header>

    <div class="border-b border-base-300 px-4 py-1.5 flex items-center gap-4 text-sm shrink-0 flex-wrap">
      <!-- media transport: prev / play-pause / next -->
      <div class="flex items-center gap-1">
        <button
          @click="stageRef?.prev()"
          :disabled="!canStep"
          class="btn btn-ghost btn-sm btn-square"
          title="上一句"
        >
          <SkipBack :size="18" />
        </button>
        <button
          @click="mainAction"
          class="btn btn-primary btn-sm btn-square"
          :title="mainTitle"
        >
          <component :is="mainIsPause ? Pause : Play" :size="18" />
        </button>
        <button
          @click="stageRef?.advance()"
          :disabled="!canStep"
          class="btn btn-ghost btn-sm btn-square"
          title="下一句"
        >
          <SkipForward :size="18" />
        </button>
      </div>
      <label class="flex items-center gap-1.5 cursor-pointer">
        <input v-model="autoPlay" type="checkbox" class="toggle toggle-primary toggle-sm" />
        自动播放
      </label>
      <label class="flex items-center gap-1.5">
        语音
        <input v-model.number="voiceVolume" type="range" min="0" max="1" step="0.05" class="range range-primary range-xs w-24" />
      </label>
      <label class="flex items-center gap-1.5">
        BGM
        <input v-model.number="bgmVolume" type="range" min="0" max="1" step="0.05" class="range range-primary range-xs w-24" />
      </label>
      <div v-if="progress.total" class="flex items-center gap-2 flex-1 min-w-32 max-w-md">
        <progress
          class="progress progress-primary flex-1"
          :value="progress.current"
          :max="progress.total"
        />
        <span class="text-xs opacity-60 tabular-nums shrink-0">第</span>
        <input
          v-model.number="jumpInput"
          type="number"
          min="1"
          :max="progress.total"
          :placeholder="String(progress.current)"
          class="input input-bordered input-xs w-14 text-center tabular-nums"
          @keyup.enter="jumpToLine"
          @blur="jumpToLine"
          title="输入句号后回车跳转"
        />
        <span class="text-xs opacity-60 tabular-nums shrink-0">/ {{ progress.total }} 句</span>
      </div>
      <span class="text-xs opacity-60 ml-auto shrink-0">{{ status }}</span>
    </div>

    <main class="flex-1 min-h-0">
      <Live2DStage
        ref="stageRef"
        :source="story.selectedSource"
        :auto-play="autoPlay"
        :voice-volume="voiceVolume"
        :bgm-volume="bgmVolume"
        @loaded="onLoaded"
        @error="onError"
        @progress="onProgress"
        @ended="onEnded"
        @pause-change="onPauseChange"
      />
    </main>
  </div>
</template>
