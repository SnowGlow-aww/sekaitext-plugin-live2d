<script setup lang="ts">
import { ref, shallowRef, onMounted, onBeforeUnmount, onDeactivated } from 'vue'
import * as PIXI from 'pixi.js'
import { Live2DModel, config } from '@sekai-world/pixi-live2d-display-mulmotion/cubism4'
import { Live2DController, type DialogLine } from '../utils/live2d/Live2DController'
import { fetchScenario } from '../utils/live2d/scenarioLoader'

// pixi-live2d-display needs PIXI global + ticker registered.
;(window as any).PIXI = PIXI
Live2DModel.registerTicker(PIXI.Ticker)
config.logLevel = config.LOG_LEVEL_ERROR

const STAGE_W = 1920
const STAGE_H = 1080

const props = defineProps<{
  source: string
  autoPlay: boolean
  voiceVolume: number
  bgmVolume: number
}>()
const emit = defineEmits<{
  loaded: []
  error: [msg: string]
  progress: [current: number, total: number]
  ended: []
  pauseChange: [paused: boolean]
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
const wrapRef = ref<HTMLDivElement | null>(null)
const dialog = ref<DialogLine | null>(null)
const telop = ref<string | null>(null)
const fullScreenText = ref<string | null>(null)
const loading = ref(false)
const errorMsg = ref('')
const playing = ref(false)
const paused = ref(false)

const app = shallowRef<PIXI.Application | null>(null)
const controller = shallowRef<Live2DController | null>(null)
const root = shallowRef<PIXI.Container | null>(null)
let checkpoint = 0

// --- playback state machine ---
// `stepping` is true while a single forward step (stepUntilCheckpoint) runs;
// `busy` serialises whole operations (a forward step OR a backward seek) so
// clicks can never overlap and corrupt `checkpoint`/`history`.
let stepping = false
let busy = false
const history: number[] = [] // checkpoints we departed FROM, for 上一步

// Re-entrancy / generation guard for play(). A 2nd concurrent play() (a 2nd editor
// jump during the ~1-2s load, or a double-click) would otherwise build a 2nd
// Live2DController and overwrite controller.value, orphaning the first — whose
// looping BGM (and PIXI models/ticker) would leak. Each play() captures
// `++playGen`; after every await it bails if a newer call has since started,
// destroying any controller it already built so its BGM/howl is stopped.
let playGen = 0

function initApp() {
  if (app.value || !canvasRef.value) return
  const a = new PIXI.Application({
    view: canvasRef.value,
    backgroundAlpha: 0,
    antialias: true,
    autoStart: true,
  })
  app.value = a
  const r = new PIXI.Container()
  a.stage.addChild(r)
  root.value = r
  fitStage()
}

function fitStage() {
  if (!app.value || !root.value || !wrapRef.value) return
  const cw = wrapRef.value.clientWidth
  const ch = wrapRef.value.clientHeight
  if (cw <= 0 || ch <= 0) return
  const scale = Math.min(cw / STAGE_W, ch / STAGE_H)
  // Size the canvas to EXACTLY the scaled 1920×1080 stage (NOT the container) and
  // let the flex wrap center it. The WebGL viewport edge then clips anything
  // outside the frame — e.g. character legs that extend below the background —
  // the same way the full-screen player's canvas edge does. A PIXI mask does NOT
  // work here: Cubism models render through their own GL path and ignore
  // container masks (the background sprite clipped, the model did not).
  app.value.renderer.resize(Math.round(STAGE_W * scale), Math.round(STAGE_H * scale))
  root.value.scale.set(scale)
  root.value.x = 0
  root.value.y = 0
}

// Resolve once the wrap element has a real (non-zero) size, then fit the stage.
// The EMBEDDED dock can mount this component with a 0×0 container (the dock turns
// visible and play() fires in the same flush, before layout). Loading the model
// while the renderer is 0×0 makes Cubism allocate its clipping-mask buffer at zero
// size, so masked parts (face/cheeks) later render as a solid magenta rectangle.
// The full-screen player already has a sized container, so this resolves at once.
function ensureSized(): Promise<void> {
  return new Promise((resolve) => {
    let tries = 0
    const check = () => {
      const el = wrapRef.value
      if (el && el.clientWidth > 0 && el.clientHeight > 0) {
        fitStage()
        resolve()
      } else if (tries++ > 120) {
        // ~2s safety cap: proceed anyway rather than hang if the container never
        // gets a size (e.g. play() somehow invoked while the dock is hidden).
        fitStage()
        resolve()
      } else {
        requestAnimationFrame(check)
      }
    }
    check()
  })
}

async function play(type: string, sort: string, index: string, chapter: number) {
  if (!app.value || !root.value) return
  // Claim a generation. A later play() bumps playGen; after each await below we
  // bail when myGen is stale so overlapping calls converge to the latest with no
  // orphaned controller. A bailing call leaves `loading` to the newer call (which
  // already set it true) and only the current owner clears it in `finally`.
  const myGen = ++playGen
  loading.value = true
  // Ensure the renderer has a real size BEFORE the model loads, or Cubism's
  // clipping-mask buffer is allocated at 0×0 and masked parts render as a pink
  // rectangle (only seen in the embedded dock — see ensureSized).
  await ensureSized()
  if (myGen !== playGen) return // superseded before we built anything
  errorMsg.value = ''
  dialog.value = null
  telop.value = null
  fullScreenText.value = null
  history.length = 0
  // Holds the controller we construct so a bail AFTER construction can destroy it
  // (stopping its BGM/howl) instead of leaking it.
  let ctrl: Live2DController | null = null
  try {
    controller.value?.destroy()
    root.value.removeChildren()

    const bgLayer = new PIXI.Container()
    const modelLayer = new PIXI.Container()
    root.value.addChild(bgLayer, modelLayer)

    const { scenario } = await fetchScenario(type, sort, index, chapter, props.source)
    if (myGen !== playGen) return // superseded during scenario fetch; nothing to destroy yet
    ctrl = new Live2DController(scenario, app.value, bgLayer, modelLayer, props.source, {
      onDialog: (l) => { dialog.value = l; if (l) telop.value = null },
      onProgress: (c, t) => emit('progress', c, t),
      onTelop: (t) => { telop.value = t },
      onFullScreenText: (t) => { fullScreenText.value = t },
    })
    ctrl.setVoiceVolume(props.voiceVolume)
    ctrl.setBgmVolume(props.bgmVolume)
    await ctrl.init()
    if (myGen !== playGen) { ctrl.destroy(); ctrl = null; return } // superseded during init: stop its BGM
    // Only now is this controller the live one.
    controller.value = ctrl
    // Start before the first snippet so the opening step lands ON snippet 0
    // (e.g. the first location banner) instead of skipping past it.
    checkpoint = -1
    playing.value = true
    paused.value = false
    emit('pauseChange', false)
    emit('loaded')
    // Take the first step to the opening checkpoint; chain autoplay if enabled.
    busy = true
    try { await runStep() } finally { busy = false }
    if (props.autoPlay) void autoLoop()
  } catch (e: any) {
    // A superseded call's failure must not clobber the newer call's UI.
    if (myGen !== playGen) { ctrl?.destroy(); return }
    errorMsg.value = e?.message || String(e)
    emit('error', errorMsg.value)
  } finally {
    if (myGen === playGen) loading.value = false
  }
}

async function runStep() {
  if (!controller.value) return
  stepping = true
  try {
    if (checkpoint >= 0) history.push(checkpoint) // don't record the pre-start sentinel (-1)
    const next = await controller.value.stepUntilCheckpoint(checkpoint)
    if (next === -1) {
      playing.value = false
      emit('ended')
    } else {
      checkpoint = next
    }
  } finally {
    stepping = false
  }
}

/** Stage click: keep the familiar feel — a click during a running step skips to
 *  the end of the current line; otherwise it advances one line. */
async function onClick() {
  if (!controller.value || !playing.value || paused.value) return
  if (stepping) { controller.value.skip(); return }
  if (busy) return
  busy = true
  try {
    await runStep()
    if (props.autoPlay) void autoLoop()
  } finally { busy = false }
}

/** 下一步 button: a single press always moves to the next line — if a step is
 *  mid-flight it skips it to completion (no need to press twice). */
async function next() {
  if (!controller.value || !playing.value) return
  if (stepping) { controller.value.skip(); return }
  if (busy) return
  busy = true
  try {
    await runStep()
    if (props.autoPlay) void autoLoop()
  } finally { busy = false }
}

/** Autoplay: after a step settles, wait briefly then take the next, until the
 *  user turns autoplay off or the scenario ends. */
async function autoLoop() {
  while (props.autoPlay && playing.value && !busy) {
    busy = true
    try {
      await runStep()
      // Autoplay paces on the voice: wait for the just-started line's voice to
      // finish before advancing. Manual 下一步/click never waits (atomic step).
      if (playing.value) await controller.value?.waitForVoice()
    } finally { busy = false }
    if (!playing.value) break
    await new Promise(r => setTimeout(r, 200))
  }
}

/** 上一步: rebuild the scene up to the previous checkpoint. seekTo replays from
 *  the start (Live2D state can't be rewound in place), now WITH voice on the
 *  landed line. Serialised through `busy`; aborts any running step first. */
async function prev() {
  if (!controller.value || !playing.value) return
  if (history.length < 1) return
  if (stepping) controller.value.skip()
  while (busy) await new Promise(r => setTimeout(r, 30))
  busy = true
  try {
    const target = history.pop() ?? 0
    await controller.value.seekTo(target)
    checkpoint = target
  } finally {
    busy = false
  }
}

/** Pause/resume playback in place (keeps position). Only meaningful while
 *  playing. */
function pauseStage() {
  if (!controller.value || !playing.value || paused.value) return
  controller.value.pause()
  paused.value = true
  emit('pauseChange', true)
}
function resumeStage() {
  if (!controller.value || !playing.value || !paused.value) return
  controller.value.resume()
  paused.value = false
  emit('pauseChange', false)
}
function togglePause() {
  paused.value ? resumeStage() : pauseStage()
}

defineExpose({
  play: (t: string, s: string, i: string, c: number) => play(t, s, i, c),
  advance: next,
  next,
  prev,
  pause: pauseStage,
  resume: resumeStage,
  togglePause,
  isPaused: () => paused.value,
  /** Jump to a 1-based dialog line: rebuild the scene up to that line's snippet
   *  (with voice on the landed line), and resync the history stack so 上一步
   *  keeps working from the jumped-to position. */
  seekToLine: async (line: number) => {
    if (!controller.value || !playing.value) return
    if (stepping) controller.value.skip()
    while (busy) await new Promise(r => setTimeout(r, 30))
    busy = true
    try {
      const target = controller.value.snippetForDialogLine(line)
      history.length = 0
      for (let n = 1; n < line; n++) history.push(controller.value.snippetForDialogLine(n))
      await controller.value.seekTo(target)
      checkpoint = target
    } finally {
      busy = false
    }
  },
  setVolumes: (v: number, b: number) => {
    controller.value?.setVoiceVolume(v)
    controller.value?.setBgmVolume(b)
  },
  // ── editor-jump resolution (used by ../jump.ts doJump) ──────────────────────
  // Resolve a clicked editor line to this player's 1-based dialog line. Both
  // return -1 when unresolved (or no story loaded) so the caller can fall back.
  /** PREFERRED: exact voice-clip-id match. */
  lineForVoiceId: (voiceId: string): number => controller.value?.dialogLineForVoiceId(voiceId) ?? -1,
  /** FALLBACK: 0-based index among Talk lines → 1-based dialog line. */
  lineForTalkIndex: (talkIndex: number): number => controller.value?.dialogLineForTalkIndex(talkIndex) ?? -1,
  /** Total dialog lines of the loaded story (0 if none), for clamping. */
  dialogLineCount: (): number => controller.value?.dialogLineCount ?? 0,
})

let ro: ResizeObserver | null = null
onMounted(() => {
  initApp()
  ro = new ResizeObserver(fitStage)
  if (wrapRef.value) ro.observe(wrapRef.value)
})
onDeactivated(() => {
  // The player page is kept alive, so navigating away (返回) does NOT unmount
  // this component and audio would keep playing. Auto-pause on leave; the user
  // resumes with the pause button when they come back.
  if (playing.value && !paused.value) pauseStage()
})
onBeforeUnmount(() => {
  ro?.disconnect()
  controller.value?.destroy()
  app.value?.destroy(false, { children: true })
  app.value = null
})
</script>

<template>
  <div ref="wrapRef" class="l2d-wrap" @click="onClick">
    <canvas ref="canvasRef" class="l2d-canvas" />

    <div v-if="telop" class="l2d-telop">
      <div class="l2d-telop-box">{{ telop }}</div>
    </div>

    <div v-if="fullScreenText" class="l2d-fulltext">
      <div class="l2d-fulltext-box">{{ fullScreenText }}</div>
    </div>

    <div v-if="dialog" class="l2d-dialog">
      <div class="l2d-dialog-box">
        <div v-if="dialog.name" class="l2d-dialog-name">{{ dialog.name }}</div>
        <div class="l2d-dialog-body">{{ dialog.body }}</div>
      </div>
    </div>

    <div v-if="loading" class="l2d-loading">
      <span class="l2d-spinner" />
    </div>
    <div v-if="errorMsg" class="l2d-error">{{ errorMsg }}</div>
    <div v-if="playing && !autoPlay" class="l2d-hint">点击推进 ▸</div>
  </div>
</template>

<style scoped>
.l2d-wrap {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #000;
  /* Center the (stage-sized) canvas so non-16:9 docks letterbox cleanly and the
     canvas edge clips model overflow. Overlays stay position:absolute → anchored
     to this wrap, not the flex flow. */
  display: flex;
  align-items: center;
  justify-content: center;
}
.l2d-canvas {
  display: block;
  /* Sized by PIXI (renderer.resize in fitStage) to the scaled stage; the flex
     wrap centers it. Do NOT force 100% — that would stretch it back over the
     letterbox and re-expose the model overflow. */
  max-width: 100%;
  max-height: 100%;
}

/* telop —— 居中横幅字 */
.l2d-telop {
  position: absolute;
  inset-inline: 0;
  top: 33.333%;
  display: flex;
  justify-content: center;
  pointer-events: none;
  padding-inline: 1.5rem;
}
.l2d-telop-box {
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 1.125rem;
  letter-spacing: 0.025em;
  border-radius: 0.25rem;
  padding: 0.75rem 1.5rem;
  text-align: center;
  white-space: pre-wrap;
}

/* fullScreenText —— 全屏黑幕大字 */
.l2d-fulltext {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.8);
  pointer-events: none;
  padding-inline: 2.5rem;
}
.l2d-fulltext-box {
  color: #fff;
  font-size: 1.5rem;
  line-height: 1.625;
  text-align: center;
  white-space: pre-wrap;
}

/* dialog —— 底部对话框（主题色取宿主 DaisyUI 变量） */
.l2d-dialog {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  bottom: 1.5rem;
  width: 80%;
  max-width: 48rem;
  pointer-events: none;
}
.l2d-dialog-box {
  background: color-mix(in oklab, var(--color-base-100) 85%, transparent);
  backdrop-filter: blur(8px);
  border: 1px solid var(--color-base-300);
  border-radius: 1rem;
  padding: 0.75rem 1.25rem;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -4px rgba(0, 0, 0, 0.1);
}
.l2d-dialog-name {
  color: var(--color-primary);
  font-weight: 600;
  font-size: 0.875rem;
  margin-bottom: 0.25rem;
}
.l2d-dialog-body {
  color: var(--color-base-content);
  font-size: 1rem;
  line-height: 1.625;
  white-space: pre-wrap;
}

/* loading 转圈 */
.l2d-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.l2d-spinner {
  width: 2.5rem;
  height: 2.5rem;
  border: 3px solid color-mix(in oklab, var(--color-primary) 30%, transparent);
  border-top-color: var(--color-primary);
  border-radius: 9999px;
  animation: l2d-spin 0.7s linear infinite;
}
@keyframes l2d-spin {
  to { transform: rotate(360deg); }
}

/* error 条 */
.l2d-error {
  position: absolute;
  top: 0.5rem;
  left: 0.5rem;
  right: 0.5rem;
  font-size: 0.75rem;
  color: var(--color-error);
  background: color-mix(in oklab, var(--color-base-200) 80%, transparent);
  border-radius: 0.25rem;
  padding: 0.25rem 0.5rem;
}

/* 推进提示 */
.l2d-hint {
  position: absolute;
  bottom: 0.25rem;
  right: 0.5rem;
  font-size: 0.75rem;
  color: color-mix(in oklab, var(--color-base-content) 50%, transparent);
  pointer-events: none;
}

/* 大屏放大字号（对齐原 md: 断点） */
@media (min-width: 768px) {
  .l2d-telop-box { font-size: 1.5rem; }
  .l2d-fulltext-box { font-size: 2.25rem; }
}
</style>
