<script setup lang="ts">
// EMBEDDABLE Live2D panel for the editor's docked region. The host frame
// (src/components/live2d/Live2DDock.vue) supplies the header / close button /
// resize handle and SIZES our container, so this component keeps its own chrome
// minimal (a slim transport bar) and MUST fill its parent — never h-screen.
//
// It mirrors Live2DPlayerPage's stage wiring but is driven by the shared dock
// store: when the editor's "在 Live2D 播放" button publishes a jump, we apply it
// here (see ../jump.ts doJump).
import { ref, computed, watch, onMounted } from 'vue'
import { Play, Pause, SkipForward, SkipBack } from 'lucide-vue-next'
import Live2DStage from './Live2DStage.vue'
import { useStoryStore, host } from '../host'
import { doJump, selKeyOf, type JumpStage } from '../jump'

const story = useStoryStore()
// The SAME reactive store instance the host + editor use, reached through the
// bridge (no shared import → no second singleton).
const dock = host().stores.live2dDock()

const stageRef = ref<InstanceType<typeof Live2DStage> | null>(null)
const autoPlay = ref(false)
const voiceVolume = ref(1)
const bgmVolume = ref(0.6)
const status = ref('')
const paused = ref(false)
const active = ref(false) // a story is loaded and not yet ended
const progress = ref({ current: 0, total: 0 })

// Identity of the currently-selected story; reload when it changes (same rule as
// Live2DPlayerPage). loadedKey is shared with doJump so a jump for the already-
// loaded story seeks in place instead of reloading.
const selKey = computed(() => selKeyOf(story))
const loadedKey = ref('')

function playSelected() {
  if (!story.selectedType || story.selectedChapter < 0) return
  status.value = '加载中...'
  loadedKey.value = selKey.value
  void stageRef.value?.play(
    story.selectedType,
    story.selectedSort,
    story.selectedIndex,
    story.selectedChapter,
  )
}
// One play/pause button: load (new/changed selection) or toggle pause/resume.
function mainAction() {
  if (!active.value || selKey.value !== loadedKey.value) playSelected()
  else stageRef.value?.togglePause()
}
const mainIsPause = computed(() => active.value && !paused.value && selKey.value === loadedKey.value)
const mainTitle = computed(() =>
  mainIsPause.value ? '暂停'
  : (active.value && paused.value && selKey.value === loadedKey.value) ? '继续'
  : '播放')
// Stepping is disabled while autoplay drives the timeline (matches Live2DPlayerPage).
const canStep = computed(() => active.value && !paused.value && !autoPlay.value)

function onLoaded() { status.value = '播放中'; active.value = true }
function onError(msg: string) { status.value = '失败: ' + msg; active.value = false }
function onEnded() { status.value = '剧情结束'; active.value = false }
function onProgress(c: number, t: number) { progress.value = { current: c, total: t } }
function onPauseChange(p: boolean) {
  paused.value = p
  if (status.value === '播放中' || status.value === '已暂停') status.value = p ? '已暂停' : '播放中'
}

// Jump to a specific dialog line via the progress input (mirrors Live2DPlayerPage).
const jumpInput = ref<number | null>(null)
function jumpToLine() {
  const total = progress.value.total
  if (!total || jumpInput.value == null) return
  const line = Math.max(1, Math.min(Math.round(jumpInput.value), total))
  stageRef.value?.seekToLine(line)
  jumpInput.value = null
}

watch([voiceVolume, bgmVolume], ([v, b]) => stageRef.value?.setVolumes(v, b))

// ── editor-driven jumps ──────────────────────────────────────────────────────
// Watch the shared dock store's pendingJump BY NONCE so repeated jumps to the
// same line still fire. lastNonce stops a re-run after consumeJump() (which nulls
// pendingJump) from looping, and de-dupes the onMounted + watcher paths.
let lastNonce = -1
// Serialise jumps: a single doJump (which can take ~1-2s when it triggers a fresh
// load) must finish before the next starts, or two overlapping play()/seek chains
// would race. While one runs, newer jumps just update dock.pendingJump; when the
// current finishes we drain to the NEWEST pending jump (loop) so none is lost.
let jumpInFlight = false
async function applyPendingJump() {
  if (jumpInFlight) return // a drain loop is already running; it will pick up the newest
  // The stage may not be mounted on the first synchronous watcher tick (the dock
  // becomes visible and publishes the jump in the same flush). onMounted retries.
  if (!stageRef.value) return
  jumpInFlight = true
  try {
    while (true) {
      const j = dock.pendingJump
      if (!j || j.nonce === lastNonce) break // nothing newer than what we've applied
      lastNonce = j.nonce
      try {
        await doJump({
          stage: stageRef.value as unknown as JumpStage,
          story,
          loadedKey,
          isActive: () => active.value,
          jump: j,
        })
      } catch (e) {
        console.warn('[live2d] applyPendingJump failed', e)
      }
      // Only clear if no newer jump arrived during doJump; otherwise loop to apply it.
      if (dock.pendingJump && dock.pendingJump.nonce === lastNonce) dock.consumeJump()
    }
  } finally {
    jumpInFlight = false
  }
}
watch(() => dock.pendingJump?.nonce, () => { void applyPendingJump() })
// Apply the jump that OPENED the dock (pendingJump was set before we mounted).
onMounted(() => { void applyPendingJump() })
</script>

<template>
  <div class="l2d-dock w-full h-full flex flex-col min-h-0 min-w-0 bg-base-100">
    <!-- transport bar (host frame provides title/close/resize). Stacked rows mirror
         Live2DPlayerPage's controller, adapted to the narrow docked width. -->
    <div class="l2d-bar flex flex-col gap-1 px-2 py-1 border-b border-base-300 shrink-0">
      <!-- row 1: prev / play-pause / next + 自动播放 + status -->
      <div class="flex items-center gap-1 flex-wrap">
        <button @click="stageRef?.prev()" :disabled="!canStep" class="btn btn-ghost btn-xs btn-square" title="上一句">
          <SkipBack :size="15" />
        </button>
        <button @click="mainAction" class="btn btn-primary btn-xs btn-square" :title="mainTitle">
          <component :is="mainIsPause ? Pause : Play" :size="15" />
        </button>
        <button @click="stageRef?.advance()" :disabled="!canStep" class="btn btn-ghost btn-xs btn-square" title="下一句">
          <SkipForward :size="15" />
        </button>
        <label class="flex items-center gap-1.5 cursor-pointer text-xs ml-1 shrink-0">
          <input v-model="autoPlay" type="checkbox" class="toggle toggle-primary toggle-sm" />
          自动播放
        </label>
        <span class="text-xs opacity-60 ml-auto shrink-0">{{ status }}</span>
      </div>
      <!-- row 2: voice + BGM volume (mirrors the full-screen player) -->
      <div class="flex items-center gap-2">
        <span class="l2d-vol-label shrink-0" title="语音音量">语音</span>
        <input v-model.number="voiceVolume" type="range" min="0" max="1" step="0.05" class="range range-primary range-xs flex-1" />
        <span class="l2d-vol-label shrink-0" title="BGM 音量">BGM</span>
        <input v-model.number="bgmVolume" type="range" min="0" max="1" step="0.05" class="range range-primary range-xs flex-1" />
      </div>
      <!-- row 3: progress bar + index jump input (第 N / 总 句) -->
      <div v-if="progress.total" class="flex items-center gap-1.5">
        <progress class="progress progress-primary flex-1" :value="progress.current" :max="progress.total" />
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
    </div>

    <!-- stage fills the rest (rounded corners to match the standalone player) -->
    <div class="flex-1 min-h-0 min-w-0 rounded-lg overflow-hidden">
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
    </div>
  </div>
</template>

<style scoped>
/* The host's Tailwind v4 purges classes it doesn't itself use, so the plugin
   self-provides every utility it relies on. Base component classes (btn / range)
   still come from the host's global @layer components. */
.w-full { width: 100%; }
.h-full { height: 100%; }
.flex { display: flex; }
.flex-col { flex-direction: column; }
.flex-wrap { flex-wrap: wrap; }
.flex-1 { flex: 1 1 0%; }
.items-center { align-items: center; }
.min-h-0 { min-height: 0; }
.min-w-0 { min-width: 0; }
.shrink-0 { flex-shrink: 0; }
.gap-1 { gap: 0.25rem; }
.gap-1\.5 { gap: 0.375rem; }
.gap-2 { gap: 0.5rem; }
.px-2 { padding-inline: 0.5rem; }
.py-1 { padding-block: 0.25rem; }
.ml-1 { margin-left: 0.25rem; }
.ml-auto { margin-left: auto; }
.w-14 { width: 3.5rem; }
.w-16 { width: 4rem; }
.cursor-pointer { cursor: pointer; }
.text-center { text-align: center; }
.rounded-lg { border-radius: 0.5rem; }
.overflow-hidden { overflow: hidden; }
.border-b { border-bottom-width: 1px; border-bottom-style: solid; }
.text-xs { font-size: 0.75rem; line-height: 1rem; }
.opacity-60 { opacity: 0.6; }
.tabular-nums { font-variant-numeric: tabular-nums; }
.l2d-vol-label { font-size: 0.7rem; line-height: 1; opacity: 0.65; }

.bg-base-100 { background-color: var(--color-base-100); }
.border-base-300 { border-color: var(--color-base-300); }

/* 方形图标按钮：宽=高、去横向内边距（btn-xs 高度约 1.5rem） */
.btn-square { width: 1.5rem; height: 1.5rem; padding-inline: 0; }

/* 进度滑条主题色：DaisyUI 的填充用 currentColor */
.range-primary { color: var(--color-primary); }

/* 跳转输入框（对齐 Live2DPlayerPage 的 input-xs）：--size 给基础 .input 算高度，再兜底显式高度 */
.input-xs {
  --size: 1.5rem;
  height: 1.5rem;
  min-height: 1.5rem;
  font-size: 0.75rem;
  padding-inline: 0.5rem;
}
.input-bordered { border: 1px solid var(--color-base-300); }

/* 进度条主题色：DaisyUI 的填充用 currentColor，设 color 即可 */
.progress-primary { color: var(--color-primary); }
</style>
