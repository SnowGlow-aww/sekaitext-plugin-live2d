// Live2D scenario playback controller (framework-agnostic).
// Ported/simplified from sekai-viewer's Live2DPlayer/Live2DController.ts. Drives
// the Snippets timeline: dialog, character appear/clear/move, motion/expression,
// lip-sync, voice/BGM, and background changes. Rendering primitives are plain
// pixi.js (model.x/y/scale/alpha + simple tweens) rather than sekai-viewer's
// heavier layer/animation framework.

import * as PIXI from 'pixi.js'
import { Live2DModel } from '@sekai-world/pixi-live2d-display-mulmotion/cubism4'
import { Howl, Howler } from 'howler'
import {
  type IScenarioData,
  SnippetAction,
  SnippetProgressBehavior,
  CharacterLayoutType,
  CharacterLayoutPosition,
  CharacterLayoutMode,
  CharacterLayoutMoveSpeedType,
  SpecialEffectType,
  SoundPlayMode,
} from '../../types/scenario'
import { loadModelSettings } from './modelLoader'
import { loadVoice, loadBgm } from './audioLoader'
import { getBackgroundUrl } from '../../constants/live2d'
import { Fullcolor, Wipe } from './effects'

export interface DialogLine {
  name: string
  body: string
}

interface ModelEntry {
  costume: string
  model: any // Live2DModel
  position: [number, number]
  hidden: boolean
  appearAt: number
  expressions: string[] // facial Names registered as the "Expression" motion group
}

const STAGE_W = 1920
const STAGE_H = 1080

export interface ControllerCallbacks {
  onDialog: (line: DialogLine | null) => void
  onProgress: (current: number, total: number) => void
  onTelop?: (text: string | null) => void
  onFullScreenText?: (text: string | null) => void
}

export class Live2DController {
  scenario: IScenarioData
  app: PIXI.Application
  bgLayer: PIXI.Container
  modelLayer: PIXI.Container
  cb: ControllerCallbacks

  models = new Map<string, ModelEntry>() // costume -> entry
  charCostume = new Map<number, string>() // Character2dId -> costume
  layoutMode: number = CharacterLayoutMode.Normal

  voices = new Map<string, Howl>()
  bgm: Howl | null = null
  bgSprite: PIXI.Sprite | null = null
  source: string

  voiceVolume = 1
  bgmVolume = 0.6
  aborted = false // per-step skip flag: set by skip()/destroy(), cleared when the next step starts
  destroyed = false // terminal: set ONLY by destroy() — use for "stop background work forever"
  silent = false // during seekTo: skip voice + instant moves
  currentVoice: Howl | null = null
  // Per-clip base volume of the currently-playing voice (its TalkData Volume,
  // before the user's voiceVolume multiplier) so the volume slider can update the
  // LIVE voice accurately, not just the next line.
  currentVoiceBase = 1
  // callbacks fired when the current step is aborted (skip / next click)
  abortCbs = new Set<() => void>()
  // models currently mid-load, so concurrent appears don't double-load
  private loadingModels = new Map<string, Promise<ModelEntry | null>>()
  private analyser?: AnalyserNode

  // effect layers (above models, below DOM text overlays)
  fxLayer!: PIXI.Container
  private fullcolor!: Fullcolor
  private wipe!: Wipe
  private grade: 'none' | 'flashback' | 'memory' | 'evening' | 'night' = 'none'
  private blurOn = false

  // Progress is reported as dialog-LINE position (not raw snippet index), so the
  // bar lines up with the translation file's text rows. talkCountUpTo[i] = number
  // of Talk snippets in Snippets[0..i]; totalTalks = total dialog lines.
  private talkCountUpTo: number[] = []
  private totalTalks = 0

  constructor(
    scenario: IScenarioData,
    app: PIXI.Application,
    bgLayer: PIXI.Container,
    modelLayer: PIXI.Container,
    source: string,
    cb: ControllerCallbacks,
  ) {
    this.scenario = scenario
    this.app = app
    this.bgLayer = bgLayer
    this.modelLayer = modelLayer
    this.source = source
    this.cb = cb
    this.fxLayer = new PIXI.Container()
    modelLayer.parent?.addChild(this.fxLayer)
    this.fullcolor = new Fullcolor(this.fxLayer)
    this.wipe = new Wipe(this.fxLayer)
    // Build the dialog-line prefix sum so the progress bar matches the editor's
    // "句" count exactly. The editor (backend parse) emits, per snippet:
    //   Talk            -> 1 row (+1 empty separator row if WhenFinishCloseWindow)
    //   SpecialEffect    -> 1 row + 1 separator, but ONLY for types 8/18/23
    //                       (location / upper-left scene / choice)
    // with a single trailing empty row trimmed. totalTalks counts ALL those rows
    // (so the denominator equals what the editor shows); talkCountUpTo[i] is the
    // row number of the primary (non-separator) entry produced at snippet i, used
    // for the displayed position and for jump mapping.
    const SCENE_EFFECTS = new Set([8, 18, 23])
    let rows = 0
    let lastWasSeparator = false
    this.talkCountUpTo = (this.scenario.Snippets || []).map((s) => {
      if (s.Action === SnippetAction.Talk) {
        rows++ // the talk row
        const primary = rows
        const t = this.scenario.TalkData?.[s.ReferenceIndex]
        if (t && t.WhenFinishCloseWindow !== 0) { rows++; lastWasSeparator = true }
        else lastWasSeparator = false
        return primary
      }
      if (s.Action === SnippetAction.SpecialEffect) {
        const e = this.scenario.SpecialEffectData?.[s.ReferenceIndex]
        if (e && SCENE_EFFECTS.has(e.EffectType)) {
          rows++ // the scene row
          const primary = rows
          rows++ // separator after effect
          lastWasSeparator = true
          return primary
        }
      }
      // Non-emitting snippet: carries the current row number forward.
      return rows
    })
    // Backend trims a single trailing empty separator row.
    this.totalTalks = lastWasSeparator ? rows - 1 : rows
  }

  /** Convert a snippet index to the dialog-line number reached at that point
   *  (1-based count of Talk snippets up to and including it), for progress UI. */
  private dialogLineAt(snippetIndex: number): number {
    if (this.talkCountUpTo.length === 0) return 0
    const i = Math.max(0, Math.min(snippetIndex, this.talkCountUpTo.length - 1))
    return this.talkCountUpTo[i]
  }

  /** Map a 1-based dialog-line number to the snippet index of that Talk (the
   *  checkpoint to land on). Clamps to range; returns the last snippet if line
   *  exceeds the count. */
  snippetForDialogLine(line: number): number {
    const n = Math.max(1, Math.min(line, this.totalTalks))
    for (let i = 0; i < this.talkCountUpTo.length; i++) {
      if (this.talkCountUpTo[i] >= n) return i
    }
    return this.scenario.Snippets.length - 1
  }

  get dialogLineCount(): number { return this.totalTalks }

  /** Map a voice clip id to the 1-based dialog-line number of the Talk snippet
   *  that plays it. Scans Snippets in order; for each Talk, checks its TalkData's
   *  Voices for an EXACT VoiceId match and returns that snippet's dialog line
   *  (talkCountUpTo[i]). Voice ids are unique per spoken line, so this is the
   *  PREFERRED jump anchor — no index arithmetic. Returns -1 if no Talk
   *  references the voice id. */
  dialogLineForVoiceId(voiceId: string): number {
    if (!voiceId) return -1
    const snippets = this.scenario.Snippets || []
    for (let i = 0; i < snippets.length; i++) {
      const s = snippets[i]
      if (s.Action !== SnippetAction.Talk) continue
      const t = this.scenario.TalkData?.[s.ReferenceIndex]
      if (t?.Voices?.some((v) => v.VoiceId === voiceId)) return this.talkCountUpTo[i]
    }
    return -1
  }

  /** Map a 0-based talkIndex (index among Talk snippets ONLY, in display order —
   *  the editor's numbering of spoken lines) to the 1-based dialog-line number
   *  this controller uses. They differ: dialog lines ALSO count scene-effect rows
   *  (location / scene / choice — SpecialEffect types 8/18/23), so a plain +1
   *  would drift. We walk Snippets counting Talk snippets; the talkIndex-th Talk's
   *  talkCountUpTo value is its dialog line. Returns -1 if talkIndex is out of
   *  range (no such Talk). */
  dialogLineForTalkIndex(talkIndex: number): number {
    if (talkIndex < 0) return -1
    const snippets = this.scenario.Snippets || []
    let count = 0
    for (let i = 0; i < snippets.length; i++) {
      if (snippets[i].Action !== SnippetAction.Talk) continue
      if (count === talkIndex) return this.talkCountUpTo[i]
      count++
    }
    return -1
  }

  /** For a landed talk snippet, find the snippet to start replay from so a voice
   *  actually plays: if `end` is a talk that has its own voice, return it; if it
   *  has none, walk back over immediately-preceding talk snippets to the nearest
   *  one that does (a continuation line whose audio is on the utterance's start).
   *  Stops walking at a non-talk snippet. Returns `end` if nothing better found. */
  private voicedStartFor(end: number): number {
    const snippets = this.scenario.Snippets
    const hasVoice = (i: number): boolean => {
      const s = snippets[i]
      if (!s || s.Action !== SnippetAction.Talk) return false
      const t = this.scenario.TalkData?.[s.ReferenceIndex]
      return !!(t && t.Voices && t.Voices.length > 0)
    }
    if (snippets[end]?.Action !== SnippetAction.Talk) return end
    if (hasVoice(end)) return end
    for (let i = end - 1; i >= 0; i--) {
      if (snippets[i]?.Action !== SnippetAction.Talk) break
      if (hasVoice(i)) return i
    }
    return end
  }

  // ---- geometry ----
  private sideToPosition(side: number, offsetX: number): [number, number] {
    const normal: Record<number, [number, number]> = {
      [CharacterLayoutPosition.Unspecified]: [0.5, 0.5],
      [CharacterLayoutPosition.Center]: [0.5, 0.5],
      [CharacterLayoutPosition.Left]: [0.3, 0.5],
      [CharacterLayoutPosition.Right]: [0.7, 0.5],
      [CharacterLayoutPosition.LeftEdge]: [-0.5, 0.5],
      [CharacterLayoutPosition.RightEdge]: [1.5, 0.5],
      [CharacterLayoutPosition.BottomLeftEdge]: [0.3, 1.5],
      [CharacterLayoutPosition.BottomEdge]: [0.5, 1.5],
      [CharacterLayoutPosition.BottomRightEdge]: [0.7, 1.5],
    }
    const three: Record<number, [number, number]> = {
      ...normal,
      [CharacterLayoutPosition.Left]: [0.25, 0.5],
      [CharacterLayoutPosition.Right]: [0.75, 0.5],
      [CharacterLayoutPosition.BottomLeftEdge]: [0.25, 1.5],
      [CharacterLayoutPosition.BottomRightEdge]: [0.75, 1.5],
    }
    const map = this.layoutMode === CharacterLayoutMode.Normal ? normal : three
    const p = [...(map[side] || [0.5, 0.5])] as [number, number]
    p[0] += offsetX / STAGE_W
    return p
  }

  private static speed(t: number): number {
    if (t === CharacterLayoutMoveSpeedType.Fast) return 300
    if (t === CharacterLayoutMoveSpeedType.Slow) return 700
    return 500
  }

  private applyTransform(entry: ModelEntry) {
    const m = entry.model
    const h = m.internalModel?.originalHeight || STAGE_H
    const scale = (STAGE_H / h) * (this.layoutMode === CharacterLayoutMode.Normal ? 2.1 : 1.8)
    m.scale.set(scale)
    m.x = STAGE_W * entry.position[0]
    m.y = STAGE_H * (entry.position[1] + 0.3)
  }

  private delay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms))
  }

  private async move(
    entry: ModelEntry,
    from: [number, number] | undefined,
    to: [number, number],
    time: number,
  ) {
    const start = from ?? entry.position
    if (this.silent || (start[0] === to[0] && start[1] === to[1])) {
      entry.position = to
      this.applyTransform(entry)
      return
    }
    const t0 = performance.now()
    return new Promise<void>((resolve) => {
      const tick = () => {
        if (this.aborted) { entry.position = to; this.applyTransform(entry); return resolve() }
        const p = Math.min(1, (performance.now() - t0) / time)
        const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2 // easeInOutQuad
        entry.position = [start[0] + (to[0] - start[0]) * e, start[1] + (to[1] - start[1]) * e]
        this.applyTransform(entry)
        if (p < 1) requestAnimationFrame(tick)
        else resolve()
      }
      tick()
    })
  }

  // ---- models ----
  /** Ensure a costume's model is loaded and added to the stage (hidden). */
  private ensureModel(costume: string): Promise<ModelEntry | null> {
    const existing = this.models.get(costume)
    if (existing) return Promise.resolve(existing)
    const inflight = this.loadingModels.get(costume)
    if (inflight) return inflight
    const p = (async () => {
      try {
        const settings = await loadModelSettings(costume)
        // Bail once destroyed: a prefetch that outlives the controller (story
        // switched mid-load) must not build a model onto the detached layer —
        // nobody would ever destroy it. (destroyed, NOT aborted: a mid-story
        // skip click must not cancel a model an upcoming scene still needs.)
        if (!settings || this.destroyed) return null
        const model = await Live2DModel.from(settings, { ticker: PIXI.Ticker.shared, autoInteract: false, breathDepth: 0.2 })
        if (this.destroyed) { try { model.destroy() } catch { /* ignore */ } return null }
        model.anchor.set(0.5, 0.5)
        model.visible = false
        // Disable the auto idle MOTION group (the story drives body motions
        // explicitly) but KEEP breathing + eye-blink so the model isn't stiff.
        // breathDepth:0.2 gives gentle head sway + body breath (matches sekai-viewer);
        // eye-blink comes from the EyeBlink group populated in modelLoader and only
        // runs when no motion is active, so it never fights an expression.
        try {
          const im: any = (model as any).internalModel
          const mm: any = im?.motionManager
          if (mm?.groups) mm.groups.idle = ''
          mm?.stopAllMotions?.()
          // A dedicated parallel motion manager (index 1) carries facial expressions
          // so they layer ON TOP of body motions instead of cancelling them.
          im?.extendParallelMotionManager?.(2)
        } catch { /* ignore */ }
        this.modelLayer.addChild(model)
        const exprNames = ((settings?.FileReferences?.Motions?.Expression as any[]) || [])
          .map((e: any) => e?.Name).filter(Boolean)
        const entry: ModelEntry = { costume, model, position: [0.5, 0.5], hidden: true, appearAt: 0, expressions: exprNames }
        this.applyTransform(entry)
        this.models.set(costume, entry)
        return entry
      } catch {
        return null
      } finally {
        this.loadingModels.delete(costume)
      }
    })()
    this.loadingModels.set(costume, p)
    return p
  }

  private costumeOf(char2dId: number): string | undefined {
    return this.charCostume.get(char2dId)
  }

  private async setCostume(char2dId: number, costume: string): Promise<string> {
    this.charCostume.set(char2dId, costume)
    await this.ensureModel(costume)
    return costume
  }

  // During a silent seek replay we record only the LAST motion/expression per
  // costume instead of starting every intermediate one — each start costs a
  // motion3 fetch + a FORCE-priority restart, and replaying hundreds of them is
  // what made 上一步/进度跳转 feel janky. flushPendingMotions applies the final
  // pose once at the end (identical visual result).
  private pendingMotions = new Map<string, { motion: string; expression: string }>()

  private flushPendingMotions() {
    if (this.silent || !this.pendingMotions.size) return
    for (const [costume, p] of this.pendingMotions) {
      if (!this.models.has(costume)) continue
      this.applyMotion(costume, p.motion, p.expression)
    }
    this.pendingMotions.clear()
  }

  /** Play a motion + expression by name on a costume's model.
   *  Each clip is injected as its own group (group name = clip name), so we call
   *  motion(name, 0). Expressions are applied via expression(name). */
  private applyMotion(costume: string, motion: string, expression: string) {
    if (this.silent) {
      const p = this.pendingMotions.get(costume) || { motion: '', expression: '' }
      if (motion) p.motion = motion
      if (expression) p.expression = expression
      this.pendingMotions.set(costume, p)
      return
    }
    const entry = this.models.get(costume)
    if (!entry) { console.warn(`[live2d] applyMotion: no loaded model for costume "${costume}" (motion=${motion} expr=${expression})`); return }
    const m = entry.model
    if (motion) {
      try { m.motion(motion, 0, 3 /* MotionPriority.FORCE */) } catch (e) { console.warn(`[live2d] motion "${motion}" failed on "${costume}"`, e) }
    }
    if (expression) {
      // Facials are motion3.json files, not Cubism .exp3.json expressions, so they
      // must be PLAYED AS MOTIONS — model.expression() mis-parses a motion3 and
      // shows the wrong face. Resolve the FacialName to its index in the
      // "Expression" motion group and force-play it on the dedicated parallel
      // manager[1], holding the last frame so the expression stays.
      try {
        const idx = entry.expressions.indexOf(expression)
        if (idx < 0) { console.warn(`[live2d] expression "${expression}" not in costume "${costume}"`); return }
        const pm = (m as any).internalModel?.parallelMotionManager?.[1]
        pm?.startMotion?.('Expression', idx, 3 /* MotionPriority.FORCE */, true /* toLastFrame */)
      } catch (e) { console.warn(`[live2d] expression "${expression}" failed on "${costume}"`, e) }
    }
  }

  private async showModel(entry: ModelEntry, time: number) {
    entry.model.visible = true
    entry.hidden = false
    if (this.silent) { entry.model.alpha = 1; return }
    const t0 = performance.now()
    return new Promise<void>((resolve) => {
      const tick = () => {
        const p = Math.min(1, (performance.now() - t0) / time)
        entry.model.alpha = p
        if (p < 1 && !this.aborted) requestAnimationFrame(tick)
        else { entry.model.alpha = 1; resolve() }
      }
      tick()
    })
  }

  private async hideModel(entry: ModelEntry, time: number) {
    if (this.silent) { entry.model.alpha = 0; entry.model.visible = false; entry.hidden = true; return }
    const t0 = performance.now()
    return new Promise<void>((resolve) => {
      const tick = () => {
        const p = Math.min(1, (performance.now() - t0) / time)
        entry.model.alpha = 1 - p
        if (p < 1 && !this.aborted) requestAnimationFrame(tick)
        else { entry.model.visible = false; entry.hidden = true; resolve() }
      }
      tick()
    })
  }

  // ---- background ----
  private bgToken = 0
  async changeBackground(img: string) {
    if (!img) return
    // During a silent seek we replay many snippets; loading every intermediate
    // background would re-download textures serially and stall the jump. Just
    // record the latest name — seekTo loads the final one once at the end.
    if (this.silent) { this.pendingBg = img; return }
    // Latest-requested background wins: a slow earlier load (or its background
    // retry below) must never overwrite a newer scene's background.
    const token = ++this.bgToken
    const url = getBackgroundUrl(img)
    try {
      // Bound the texture load: PIXI.Texture.fromURL only settles on a load or
      // error event, so a stalled proxy response (no extension to sniff, hung
      // socket) would otherwise hang the whole timeline at this checkpoint.
      const tex = await Promise.race([
        PIXI.Texture.fromURL(url),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('background load timeout')), 8000)),
      ])
      if (token === this.bgToken) this.applyBgTexture(tex)
    } catch {
      // Timed out or failed. Keep the timeline moving, but repair in the
      // background instead of giving up: a COLD mirror fetch can exceed the 8s
      // cap (apply it late, not never), and a genuinely FAILED load poisons
      // PIXI's URL cache — every later attempt rejects instantly until app
      // restart ("background missing until restart") unless we evict + refetch.
      void this.retryBackground(url, token)
    }
  }

  private applyBgTexture(tex: PIXI.Texture) {
    if (this.bgSprite) {
      this.bgSprite.texture = tex
    } else {
      this.bgSprite = new PIXI.Sprite(tex)
      this.bgLayer.addChild(this.bgSprite)
    }
    const s = this.bgSprite
    s.anchor.set(0.5)
    s.x = STAGE_W / 2
    s.y = STAGE_H / 2
    // Cover-fit the stage. The texture may not have valid dimensions the instant
    // fromURL resolves (especially when swapping the texture on a reused sprite),
    // which yields a wrong/zero scale and leaves the bg as thin strips with a
    // black band. Fit once now, and re-fit when the base texture finishes loading.
    const fit = () => {
      const tw = s.texture.width, th = s.texture.height
      if (!tw || !th) return
      s.scale.set(Math.max(STAGE_W / tw, STAGE_H / th))
    }
    fit()
    const base = tex.baseTexture
    if (!base.valid) base.once('loaded', fit)
  }

  /** Second-chance background load after the bounded attempt gave up. */
  private async retryBackground(url: string, token: number) {
    try {
      // First ride the ORIGINAL request with no time cap: if it was merely slow
      // (cold CDN back-to-origin), fromURL returns the same cached promise and
      // the background pops in late rather than staying black.
      const tex = await PIXI.Texture.fromURL(url)
      if (token === this.bgToken) this.applyBgTexture(tex)
      return
    } catch { /* genuinely failed — evict the poisoned cache entry and refetch */ }
    Live2DController.evictTexture(url)
    try {
      const tex = await PIXI.Texture.fromURL(url)
      if (token === this.bgToken) this.applyBgTexture(tex)
    } catch {
      // Still failing: leave the cache clean so a FUTURE change to this
      // background (same story or another) starts from a fresh request.
      Live2DController.evictTexture(url)
    }
  }

  /** Drop a URL from PIXI's global texture caches. fromURL caches by URL —
   *  INCLUDING failed loads — so one transient proxy/CDN error would otherwise
   *  poison that background for the whole app session. */
  private static evictTexture(url: string) {
    try {
      const cached: PIXI.Texture | undefined = PIXI.utils.TextureCache[url]
      PIXI.Texture.removeFromCache(url)
      PIXI.BaseTexture.removeFromCache(url)
      cached?.destroy(true)
    } catch { /* eviction is best-effort */ }
  }
  private pendingBg: string | null = null


  // ---- audio ----
  private playBgmTrack(howl: Howl) {
    // BGM is loaded fire-and-forget (loadBgm(...).then(...) in init/seek), so this
    // can resolve AFTER the controller was destroyed (e.g. a superseded play()).
    // Without this guard the looping howl would never be tracked for unload and
    // would play forever — the orphaned-BGM leak. Stop it immediately instead.
    if (this.aborted) { howl.stop(); howl.unload(); return }
    if (this.bgm) this.bgm.stop()
    this.bgm = howl
    howl.loop(true)
    howl.volume(this.bgmVolume)
    howl.play()
  }

  /** Detach the lip-sync analyser from every model so no one keeps mouthing once
   *  they're no longer the active speaker. The lib reads motionManager.currentAnalyzer;
   *  there's no detach API, so clear it directly. */
  private clearLipSync() {
    this.models.forEach((e) => {
      const mm: any = e.model?.internalModel?.motionManager
      if (mm && mm.currentAnalyzer) mm.currentAnalyzer = undefined
    })
  }

  private speak(costumes: string[], howl: Howl, volume: number) {
    // Lip-sync: route howler's gain node through an AnalyserNode the model reads.
    try {
      const ctx = Howler.ctx
      if (ctx && costumes.length) {
        if (!this.analyser) this.analyser = ctx.createAnalyser()
        const node = (howl as any)._sounds?.[0]?._node as AudioNode | undefined
        if (node) {
          node.disconnect()
          node.connect(this.analyser)
          this.analyser.connect(Howler.masterGain)
        }
        // Only the current speaker(s) should lip-sync: detach the shared analyser
        // from everyone else first, otherwise a previous speaker keeps mouthing
        // (two characters appear to talk at once).
        this.clearLipSync()
        for (const c of costumes) {
          const e = this.models.get(c)
          if (e?.model?.internalModel?.motionManager?.attachAnalyzer) {
            e.model.internalModel.motionManager.attachAnalyzer(this.analyser)
          }
        }
      }
    } catch {
      /* lip-sync unavailable — play without it */
    }
    howl.volume(volume)
    howl.play()
  }

  // ---- init ----
  async init() {
    this.layoutMode = this.scenario.FirstCharacterLayoutMode ?? CharacterLayoutMode.Normal
    if (this.scenario.FirstBackground) await this.changeBackground(this.scenario.FirstBackground)
    // Map every Character2dId -> costume from both AppearCharacters and any
    // LayoutData Appear (some costumes only enter via layout, not the appear list).
    const appears = this.scenario.AppearCharacters || []
    for (const c of appears) this.charCostume.set(c.Character2dId, c.CostumeType)
    for (const l of this.scenario.LayoutData || []) {
      if (l.CostumeType && !this.charCostume.has(l.Character2dId)) {
        this.charCostume.set(l.Character2dId, l.CostumeType)
      }
    }
    if (this.scenario.FirstBgm) {
      // Don't block playback start on BGM; load it in the background.
      loadBgm(this.scenario.FirstBgm).then((a) => { if (a) this.playBgmTrack(a.howl) })
    }
    this.cb.onProgress(0, this.totalTalks)
    // Preload ALL assets this scenario needs in the BACKGROUND (no await):
    // playback starts immediately while models/motions and every voice clip load
    // behind it, so a talk's motion is ready by the time its voice plays.
    void this.prefetchAll()
  }

  /** Background-preload all costumes (models + motions) and all voice clips this
   *  scenario references, so playback never reaches a line whose model/motion or
   *  voice hasn't loaded yet. Fire-and-forget; failures are swallowed per-item.
   *  THROTTLED: firing every model (moc parse + texture decode/upload) and every
   *  voice (proxied fetch + full Web-Audio decode) at once stuttered the opening
   *  seconds of playback — and kept downloading after a story switch. Models load
   *  one at a time, voices through a small worker pool, and both stop at abort. */
  private async prefetchAll() {
    // Models: every costume that ever appears (from charCostume, populated in
    // init), sequentially. On-demand loads (actionLayout awaits ensureModel)
    // still jump the queue naturally via loadingModels.
    const costumes = [...new Set(this.charCostume.values())]
    void (async () => {
      for (const c of costumes) {
        if (this.destroyed) return
        try { await this.ensureModel(c) } catch { /* per-item best effort */ }
      }
    })()
    // Voices: every VoiceId across all TalkData, deduped, in timeline order so
    // early lines are ready first.
    if (!this.silent) {
      const items: { vid: string; c2d?: number }[] = []
      const seen = new Set<string>()
      for (const t of this.scenario.TalkData || []) {
        for (const v of t.Voices || []) {
          if (v.VoiceId && !seen.has(v.VoiceId)) {
            seen.add(v.VoiceId)
            items.push({ vid: v.VoiceId, c2d: v.Character2dId })
          }
        }
      }
      let next = 0
      const worker = async () => {
        while (next < items.length) {
          if (this.destroyed) return
          const { vid, c2d } = items[next++]
          if (this.voices.has(vid)) continue
          try {
            const a = await loadVoice(this.scenario.ScenarioId, vid, this.source, c2d)
            // A load resolving after destroy() must not repopulate the cleared
            // map (the howl would never be unloaded) — drop it instead.
            if (!a) continue
            if (this.destroyed) { try { a.howl.unload() } catch { /* ignore */ } ; return }
            if (!this.voices.has(vid)) this.voices.set(vid, a.howl)
          } catch { /* preload best-effort */ }
        }
      }
      for (let w = 0; w < 3; w++) void worker()
    }
  }

  setVoiceVolume(v: number) { this.voiceVolume = v; this.currentVoice?.volume(this.currentVoiceBase * v) }
  setBgmVolume(v: number) { this.bgmVolume = v; this.bgm?.volume(v) }

  /** Rebuild scene state from the start up to `target`. Snippets before the
   *  landed checkpoint are applied silently (no voice, instant moves); the landed
   *  snippet itself is applied normally so its voice/motion play — 上一步 should
   *  feel like arriving on that line, not a muted fast-forward. */
  async seekTo(target: number) {
    this.aborted = false
    this.currentVoice?.stop()
    this.currentVoice = null
    this.clearLipSync()
    this.resetEffects() // clear leftover curtains/wipes/filters so the rebuild isn't blacked out
    this.models.forEach((e) => { e.model.visible = false; e.hidden = true })
    this.cb.onDialog(null)
    this.pendingBg = null
    this.pendingBgm = null
    this.pendingMotions.clear()
    const end = Math.min(target, this.scenario.Snippets.length - 1)
    // Silent fast-forward up to (but not including) the landed snippet. Each
    // action is isolated: one bad snippet (missing asset/ref) must not abort the
    // whole seek, or a long jump would dump the viewer back at the start.
    this.silent = true
    try {
      for (let i = 0; i < end; i++) {
        try { await this.applyAction(i) } catch { /* skip bad snippet, keep seeking */ }
      }
    } finally {
      this.silent = false
    }
    // Apply the final recorded motion/expression per costume once (intermediate
    // ones were only recorded during the silent replay — see pendingMotions).
    // Before the landed snippet, so its own motions still win.
    this.flushPendingMotions()
    // Load the final background once (intermediate ones were skipped during the
    // silent replay so the jump stays fast and the landed scene is fully drawn).
    if (this.pendingBg) {
      const bg = this.pendingBg
      this.pendingBg = null
      await this.changeBackground(bg)
    }
    // Start the final BGM once (skipped during replay), unless it's already the
    // track playing — avoids restarting the same BGM on every seek.
    if (this.pendingBgm) {
      const bgm = this.pendingBgm
      this.pendingBgm = null
      loadBgm(bgm).then((a) => { if (a) this.playBgmTrack(a.howl) })
    }
    // Apply the landed snippet with sound, if playback wasn't aborted meanwhile.
    // If the landed snippet is a talk that carries no voice of its own (a
    // continuation line whose audio lives on an earlier snippet of the same
    // utterance), replay from that earlier voiced snippet so the line is spoken.
    if (!this.aborted && end >= 0) {
      const voicedStart = this.voicedStartFor(end)
      try {
        if (voicedStart < end) {
          // Re-apply from the voiced start through end so the voice plays and the
          // final dialog/state still reflects the landed line.
          for (let i = voicedStart; i <= end; i++) {
            await this.applyAction(i)
          }
        } else {
          await this.applyAction(end)
        }
      } catch { /* ignore */ }
    }
    this.cb.onProgress(this.dialogLineAt(target), this.totalTalks)
  }

  destroy() {
    this.aborted = true
    this.destroyed = true
    // Release any waiters hung on this controller (waitForVoice etc.) so a step
    // that was mid-flight can settle instead of pinning its caller forever.
    for (const cb of [...this.abortCbs]) { try { cb() } catch { /* ignore */ } }
    this.abortCbs.clear()
    this.currentVoice = null
    // Per-item guards: destroy() runs while the NEXT story starts loading; one
    // throwing unload/destroy (e.g. a model whose assets are still mid-download)
    // escaping here would abort that load and strand the old scene on screen.
    this.voices.forEach((h) => { try { h.unload() } catch { /* ignore */ } })
    this.voices.clear()
    try { this.bgm?.unload() } catch { /* ignore */ }
    this.bgm = null
    this.models.forEach((e) => { try { e.model.destroy() } catch { /* ignore */ } })
    this.models.clear()
  }

  // ---- pause / resume ----
  // paused freezes audio (BGM + current voice) and model animation in place,
  // keeping playback position so resume() continues from the same spot. Used
  // when leaving the player page (kept-alive) so it doesn't keep playing in the
  // background, and by the toolbar pause button.
  paused = false
  private voiceWasPlaying = false
  pause() {
    if (this.paused) return
    this.paused = true
    this.bgm?.pause()
    this.voiceWasPlaying = !!this.currentVoice?.playing()
    if (this.voiceWasPlaying) this.currentVoice!.pause()
    this.app.ticker.stop() // freeze model motion / effects
  }
  resume() {
    if (!this.paused) return
    this.paused = false
    this.app.ticker.start()
    this.bgm?.play()
    // Only resume the voice if WE paused it mid-play (not one that had finished).
    if (this.voiceWasPlaying && this.currentVoice) this.currentVoice.play()
    this.voiceWasPlaying = false
  }

  // ---- actions ----
  private async applyAction(index: number) {
    const snippet = this.scenario.Snippets[index]
    if (!snippet) return
    switch (snippet.Action) {
      case SnippetAction.Talk:
        await this.actionTalk(snippet.ReferenceIndex)
        break
      case SnippetAction.CharacterLayout:
        await this.actionLayout(snippet.ReferenceIndex)
        break
      case SnippetAction.CharacterMotion:
        await this.actionMotion(snippet.ReferenceIndex)
        break
      case SnippetAction.SpecialEffect:
        await this.actionSpecialEffect(snippet.ReferenceIndex)
        break
      case SnippetAction.Sound:
        await this.actionSound(snippet.ReferenceIndex)
        break
      case SnippetAction.CharacterLayoutMode:
        this.layoutMode =
          this.scenario.ScenarioSnippetCharacterLayoutModes?.[snippet.ReferenceIndex]?.CharacterLayoutMode ??
          this.layoutMode
        break
    }
  }

  private async actionTalk(ref: number) {
    const t = this.scenario.TalkData[ref]
    if (!t) return
    this.cb.onDialog({ name: t.WindowDisplayName, body: t.Body })

    // Apply motions/expressions to whatever models are already loaded. We do NOT
    // block on model loading here: awaiting ensureModel() could hang the whole
    // timeline if a model's assets stall, freezing playback. prefetchAll() loads
    // every costume up front, so they're almost always ready; if not, the motion
    // is simply skipped for that line rather than stalling.
    for (const m of t.Motions || []) {
      const costume = this.costumeOf(m.Character2dId)
      if (costume) this.applyMotion(costume, m.MotionName, m.FacialName)
    }

    if (!this.silent && t.Voices?.length) {
      const vid = t.Voices[0].VoiceId
      let howl = this.voices.get(vid)
      if (!howl) {
        const a = await loadVoice(this.scenario.ScenarioId, vid, this.source, t.Voices[0].Character2dId)
        // The step may have been skipped (or the controller destroyed) while the
        // clip loaded — starting it now would talk over the next line. Keep the
        // clip cached for a live controller; unload it for a destroyed one.
        if (this.destroyed) { if (a) { try { a.howl.unload() } catch { /* ignore */ } } return }
        if (a && !this.voices.has(vid)) this.voices.set(vid, a.howl)
        howl = a ? this.voices.get(vid) : undefined
        if (this.aborted) return
      }
      if (howl) {
        this.currentVoice = howl
        this.currentVoiceBase = t.Voices[0].Volume ?? 1
        const costumes = (t.TalkCharacters || [])
          .map((c) => this.costumeOf(c.Character2dId))
          .filter((c): c is string => !!c)
        const vol = this.currentVoiceBase * this.voiceVolume
        if (costumes.length && t.LipSync === 1) this.speak(costumes, howl, vol)
        else {
          // Not a lip-synced line (monologue / no speaker): make sure nobody is
          // still mouthing from a previous line.
          this.clearLipSync()
          howl.volume(vol); howl.play()
        }
        console.info(`[live2d] voice "${vid}" play (vol=${vol} lipSync=${t.LipSync} costumes=${costumes.length} playing=${howl.playing()})`)
      } else {
        console.warn(`[live2d] voice "${vid}": no howl available (load failed) — line will be silent`)
      }
    }
  }

  /** Abort the current step: stop the voice and resolve any waiters so advance()
   *  jumps straight to the next checkpoint. */
  skip() {
    this.aborted = true
    this.currentVoice?.stop()
    this.currentVoice = null
    this.clearLipSync()
    for (const cb of [...this.abortCbs]) cb()
    this.abortCbs.clear()
  }

  private async actionLayout(ref: number) {
    const l = this.scenario.LayoutData[ref]
    if (!l) return
    if (l.Type === CharacterLayoutType.Appear) {
      const costume = l.CostumeType
        ? await this.setCostume(l.Character2dId, l.CostumeType)
        : this.costumeOf(l.Character2dId)
      if (!costume) return
      const entry = await this.ensureModel(costume)
      if (!entry) return
      this.applyMotion(costume, l.MotionName, l.FacialName)
      const from = this.sideToPosition(l.SideFrom, l.SideFromOffsetX)
      const to = this.sideToPosition(l.SideTo, l.SideToOffsetX)
      entry.position = from
      this.applyTransform(entry)
      entry.appearAt = performance.now()
      await Promise.all([
        this.showModel(entry, 200),
        this.move(entry, from, to, Live2DController.speed(l.MoveSpeedType)),
      ])
    } else if (l.Type === CharacterLayoutType.Clear) {
      const costume = this.costumeOf(l.Character2dId)
      const entry = costume ? this.models.get(costume) : undefined
      if (!entry) return
      const from = this.sideToPosition(l.SideFrom, l.SideFromOffsetX)
      const to = this.sideToPosition(l.SideTo, l.SideToOffsetX)
      await this.move(entry, from, to, Live2DController.speed(l.MoveSpeedType))
      const stay = 2000 - (performance.now() - entry.appearAt)
      if (stay > 0 && !this.silent) await this.delay(stay)
      await this.hideModel(entry, 200)
    } else {
      const costume = this.costumeOf(l.Character2dId)
      const entry = costume ? this.models.get(costume) : undefined
      if (!entry || !costume) return
      this.applyMotion(costume, l.MotionName, l.FacialName)
      const to = this.sideToPosition(l.SideTo, l.SideToOffsetX)
      await this.move(entry, undefined, to, Live2DController.speed(l.MoveSpeedType))
    }
  }

  private async actionMotion(ref: number) {
    const l = this.scenario.LayoutData[ref]
    if (!l) return
    const costume = this.costumeOf(l.Character2dId)
    if (costume) this.applyMotion(costume, l.MotionName, l.FacialName)
  }

  private async actionSpecialEffect(ref: number) {
    const e = this.scenario.SpecialEffectData[ref]
    if (!e) return
    const T = SpecialEffectType
    const dur = (e.Duration || 0) * 1000
    const inst = this.silent
    const ab = () => this.aborted
    switch (e.EffectType) {
      case T.ChangeBackground:
      case T.ChangeBackgroundStill:
        await this.changeBackground(e.StringValSub || e.StringVal)
        break
      // --- full-screen color fades (In = reveal, Out = cover) ---
      // ab() lets a click/skip snap the curtain to its final state instead of
      // leaving it stuck at a partial alpha (the white/black mask bug).
      // During a silent seek, "Out" (cover) curtains are skipped — they are
      // transitions, not a state a landed dialogue line should sit under, so
      // replaying them would black out the rebuilt scene. "In" (reveal) still
      // forces the curtain clear.
      case T.BlackIn:
        this.fullcolor.draw(0x000000); this.fullcolor.g.alpha = 1
        this.wipe.cancel() // stop an in-flight wipe too, or its ticks re-cover the reveal
        this.wipe.g.visible = false // a full reveal supersedes any lingering wipe panel
        await this.fullcolor.hide(dur || 500, inst, ab)
        break
      case T.BlackOut:
        if (this.silent) break
        this.fullcolor.draw(0x000000)
        await this.fullcolor.show(dur || 500, inst, ab)
        break
      case T.WhiteIn:
        this.fullcolor.draw(0xffffff); this.fullcolor.g.alpha = 1
        this.wipe.cancel() // stop an in-flight wipe too, or its ticks re-cover the reveal
        this.wipe.g.visible = false // a full reveal supersedes any lingering wipe panel
        await this.fullcolor.hide(dur || 500, inst, ab)
        break
      case T.WhiteOut:
        if (this.silent) break
        this.fullcolor.draw(0xffffff)
        await this.fullcolor.show(dur || 500, inst, ab)
        break
      // --- directional black wipes (transitions; skipped entirely during a
      // silent seek so the panel is never left covering the rebuilt scene) ---
      case T.BlackWipeInLeft: if (this.silent) break; await this.wipe.wipeIn('left', dur || 400, inst, ab); break
      case T.BlackWipeInRight: if (this.silent) break; await this.wipe.wipeIn('right', dur || 400, inst, ab); break
      case T.BlackWipeInTop: if (this.silent) break; await this.wipe.wipeIn('top', dur || 400, inst, ab); break
      case T.BlackWipeInBottom: if (this.silent) break; await this.wipe.wipeIn('bottom', dur || 400, inst, ab); break
      case T.BlackWipeOutLeft: if (this.silent) break; await this.wipe.wipeOut('left', dur || 400, inst, ab); break
      case T.BlackWipeOutRight: if (this.silent) break; await this.wipe.wipeOut('right', dur || 400, inst, ab); break
      case T.BlackWipeOutTop: if (this.silent) break; await this.wipe.wipeOut('top', dur || 400, inst, ab); break
      case T.BlackWipeOutBottom: if (this.silent) break; await this.wipe.wipeOut('bottom', dur || 400, inst, ab); break
      // --- color-grade filters ---
      case T.FlashbackIn: this.grade = 'flashback'; this.applyGrade(); break
      case T.FlashbackOut: if (this.grade === 'flashback') { this.grade = 'none'; this.applyGrade() } break
      case T.MemoryIn: this.grade = 'memory'; this.applyGrade(); break
      case T.MemoryOut: if (this.grade === 'memory') { this.grade = 'none'; this.applyGrade() } break
      case T.AmbientColorEvening: this.grade = 'evening'; this.applyGrade(); break
      case T.AmbientColorNight: this.grade = 'night'; this.applyGrade(); break
      case T.AmbientColorNormal: this.grade = 'none'; this.applyGrade(); break
      case T.Blur: this.blurOn = true; this.applyGrade(); break
      // --- text overlays (handled by Stage via callbacks) ---
      case T.Telop:
        this.cb.onTelop?.(e.StringVal)
        break
      case T.FullScreenText:
      case T.FullScreenTextShow:
        this.cb.onFullScreenText?.(e.StringVal)
        break
      case T.FullScreenTextHide:
        this.cb.onFullScreenText?.(null)
        break
      // --- screen shake ---
      case T.ShakeScreen:
        if (!inst) this.shakeScreen(dur || 500)
        break
      case T.StopShakeScreen:
        this.stopShake = true
        break
      default:
        // unsupported effect — skip safely
        break
    }
  }

  /** Clear all full-screen visual effects to a neutral, fully-revealed state.
   *  Called before a seek replay so leftover curtains/wipes/filters from a prior
   *  position can't black out or tint the rebuilt scene. The replay re-applies
   *  whatever effects are actually active at the target. */
  private resetEffects() {
    // Cancel in-flight curtain/wipe tweens FIRST: a still-ticking BlackOut from
    // the pre-seek timeline would keep writing alpha after this reset (the seek
    // replay clears this.aborted, so its abort check no longer stops it) and
    // re-black the rebuilt scene.
    this.fullcolor.cancel()
    this.wipe.cancel()
    this.fullcolor.g.alpha = 0
    this.fullcolor.g.visible = true
    this.wipe.g.visible = false
    this.grade = 'none'
    this.blurOn = false
    this.stopShake = true
    this.applyGrade()
  }

  // ---- color grading (ColorMatrixFilter on bg + models) ----
  private applyGrade() {
    const filters: PIXI.Filter[] = []
    const cm = (saturate: number, r: number, g: number, b: number) => {
      const f = new PIXI.ColorMatrixFilter()
      f.saturate(saturate, false)
      f.matrix = [r, 0, 0, 0, 0, 0, g, 0, 0, 0, 0, 0, b, 0, 0, 0, 0, 0, 1, 0] as any
      return f
    }
    switch (this.grade) {
      case 'flashback': filters.push(cm(-0.7, 0.9, 0.85, 0.7)); break
      case 'memory': filters.push(cm(-0.5, 0.8, 0.8, 0.5)); break
      case 'evening': filters.push(cm(-0.1, 0.95, 0.85, 0.7)); break
      case 'night': filters.push(cm(-0.1, 0.8, 0.85, 1.0)); break
      case 'none': break
    }
    const bgFilters: PIXI.Filter[] = [...filters]
    if (this.blurOn) bgFilters.push(new PIXI.BlurFilter(6))
    this.modelLayer.filters = filters.length ? filters : null
    this.bgLayer.filters = bgFilters.length ? bgFilters : null
  }

  private stopShake = false
  private shakeScreen(ms: number) {
    const root = this.modelLayer.parent
    if (!root) return
    this.stopShake = false
    const baseX = root.x, baseY = root.y
    const t0 = performance.now()
    const tick = () => {
      if (this.stopShake || this.aborted) { root.x = baseX; root.y = baseY; return }
      const t = performance.now() - t0
      if (t >= ms) { root.x = baseX; root.y = baseY; return }
      const decay = 1 - t / ms
      root.x = baseX + Math.sin(t / 18) * 14 * decay
      root.y = baseY + Math.cos(t / 13) * 10 * decay
      requestAnimationFrame(tick)
    }
    tick()
  }

  private async actionSound(ref: number) {
    const s = this.scenario.SoundData[ref]
    if (!s) return
    if (s.PlayMode === SoundPlayMode.SetBgmVolume) {
      if (!this.silent) this.bgm?.volume(s.Volume * this.bgmVolume)
      return
    }
    if (s.Bgm) {
      // During a silent seek, don't load every BGM the story passed through —
      // just remember the latest; seekTo starts only the final one at the end.
      if (this.silent) { this.pendingBgm = s.Bgm; return }
      const a = await loadBgm(s.Bgm)
      if (a) this.playBgmTrack(a.howl)
    }
  }
  private pendingBgm: string | null = null

  // ---- timeline ----
  private isEnd(step: number) {
    return step >= this.scenario.Snippets.length - 1
  }

  private isStop(step: number): boolean {
    if (this.isEnd(step)) return true
    const a = this.scenario.Snippets[step]
    if (a.ProgressBehavior === SnippetProgressBehavior.Now) return false
    if (a.Action === SnippetAction.Talk) return true
    if (a.Action === SnippetAction.SpecialEffect) {
      const e = this.scenario.SpecialEffectData[a.ReferenceIndex]
      if (e && (e.EffectType === SpecialEffectType.Telop || e.EffectType === SpecialEffectType.FullScreenText)) return true
    }
    return false
  }

  /**
   * Advance from `step` to the next checkpoint. Consecutive Now snippets run in
   * parallel; WaitUntilFinished snippets start a new sequential group. Returns
   * the next checkpoint index, or -1 at end.
   */
  async stepUntilCheckpoint(step: number): Promise<number> {
    this.aborted = false
    // Stop the previous line's voice before this step starts a new one — manual
    // steps are atomic and return while the voice may still be playing, so a
    // lingering clip would overlap the next line's voice.
    this.currentVoice?.stop()
    this.currentVoice = null
    const snippets = this.scenario.Snippets
    const groups: number[][] = []
    let current = step
    do {
      current++
      if (current >= snippets.length) break
      if (snippets[current].ProgressBehavior === SnippetProgressBehavior.Now) {
        if (groups.length === 0) groups.push([current])
        else groups[groups.length - 1].push(current)
      } else {
        groups.push([current])
      }
    } while (!this.isStop(current))
    while (
      !this.isEnd(current) &&
      current + 1 < snippets.length &&
      snippets[current + 1].ProgressBehavior === SnippetProgressBehavior.Now
    ) {
      current++
      groups[groups.length - 1].push(current)
    }

    for (const group of groups) {
      if (this.aborted) {
        // A click/skip aborted mid-step. Don't just stop — that can freeze the
        // scene mid-transition (e.g. BlackOut applied but its paired BlackIn
        // skipped, leaving a black curtain). Fast-forward the remaining groups
        // with effects in silent mode: cover-curtains/wipes are skipped, reveals
        // snap clear, so the final visual state is correct. Backgrounds queued
        // during the silent run are flushed right after.
        const wasSilent = this.silent
        this.silent = true
        for (const i of group) { try { await this.applyAction(i) } catch { /* ignore */ } }
        this.silent = wasSilent
        continue
      }
      await Promise.all(group.map((i) => this.applyAction(i)))
    }
    // If the abort fast-forward queued a background or motions, apply them now
    // (silent mode only records the latest to avoid mid-transition churn).
    this.flushPendingMotions()
    if (this.pendingBg) {
      const bg = this.pendingBg
      this.pendingBg = null
      await this.changeBackground(bg)
    }

    // Report progress as soon as the line is on screen. A step is ATOMIC: it
    // presents the line (dialog shown, voice started) and returns immediately.
    // It does NOT wait for the voice — that wait is only for autoplay pacing and
    // is done by the caller via waitForVoice(). Keeping the wait inside the step
    // made manual 下一步 need two presses (the first press's step sat blocked on
    // the voice) and corrupted prev()'s history bookkeeping.
    this.cb.onProgress(this.dialogLineAt(current), this.totalTalks)

    return this.isEnd(current) ? -1 : current
  }

  /** Wait for the currently-playing talk voice to finish, for autoplay pacing.
   *  Resolves immediately if no voice is playing or on skip/abort; a duration
   *  timeout guarantees it always resolves even if howler's 'end' never fires
   *  (proxied URLs sometimes don't). */
  async waitForVoice(): Promise<void> {
    if (!this.currentVoice || !this.currentVoice.playing()) return
    const v = this.currentVoice
    await new Promise<void>((resolve) => {
      if (this.aborted) return resolve()
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = () => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        v.off('end', finish)
        this.abortCbs.delete(finish)
        resolve()
      }
      v.once('end', finish)
      this.abortCbs.add(finish)
      const dur = (typeof v.duration === 'function' ? v.duration() : 0) || 0
      timer = setTimeout(finish, dur > 0 ? dur * 1000 + 500 : 8000)
    })
  }
}
