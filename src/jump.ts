// Shared "play this editor line in Live2D" logic, used by BOTH the docked panel
// (components/Live2DDockPanel.vue) and the separate-window player route
// (components/Live2DPlayerPage.vue) so the two paths behave identically.
//
// It maps a host jump request onto the player's dialog-line timeline and seeks.
//
// ── MAPPING (see the SHARED HOST CONTRACT + Live2DController) ────────────────
//  1. PREFER jump.voiceId — find the Talk snippet whose voice clip id matches and
//     seek to ITS dialog line (Live2DController.dialogLineForVoiceId). Voice ids
//     are unique per spoken line, so this is exact, with NO index arithmetic.
//  2. FALL BACK to jump.talkIndex — a 0-based index among the story's Talk
//     (spoken) lines in display order. The player's dialog-line numbering is
//     1-based and ALSO counts certain scene-effect rows (location / scene /
//     choice), so talkIndex is NOT the same number as the dialog line. We convert
//     by walking the snippet list, counting Talk snippets, and taking the
//     talkCountUpTo value of the talkIndex-th Talk
//     (Live2DController.dialogLineForTalkIndex). Result is the 1-based dialog line.
//  3. If neither resolves (e.g. voiceless line whose talkIndex fell out of range
//     after a story edit), seek to the NEAREST in-range line (clamp talkIndex+1)
//     and console.warn rather than failing the jump.

// The host's full story-selection snapshot, carried on a jump so a 独立窗口 (a
// fresh JS context with an EMPTY story store) can populate its store and resolve
// stage.play()/source. type/sort/index/source are strings; chapter is a number.
export interface JumpSel {
  type: string
  sort: string
  index: string
  chapter: number
  source: string
}

export interface Jump {
  scenarioId?: string
  talkIndex: number
  voiceId?: string
  nonce?: number
  // Present for separate-window jumps (and harmlessly for docked). When set, the
  // plugin writes it into the host story store BEFORE seeking — see
  // Live2DPlayerPage.applySel + the M3 SEPARATE-WINDOW JUMP CONTRACT.
  sel?: JumpSel
}

// The minimal slice of the Live2DStage `defineExpose` surface that doJump needs.
export interface JumpStage {
  play(type: string, sort: string, index: string, chapter: number): Promise<void>
  seekToLine(line: number): Promise<void>
  lineForVoiceId(voiceId: string): number
  lineForTalkIndex(talkIndex: number): number
  dialogLineCount(): number
}

// Identity of the host story store's current selection — the SAME tuple
// Live2DPlayerPage.playSelected() feeds to stage.play(). Used to detect when a
// reload is needed vs. seeking within the already-loaded story.
export function selKeyOf(story: any): string {
  return `${story.selectedType}|${story.selectedSort}|${story.selectedIndex}|${story.selectedChapter}`
}

export interface DoJumpOptions {
  // The mounted Live2DStage instance (its defineExpose surface). null = not ready.
  stage: JumpStage | null | undefined
  // The shared host story store (host.stores.story()). doJump derives the play()
  // args from its selection — exactly like Live2DPlayerPage does.
  story: any
  // Ref-like holder of the currently-loaded selection key, so repeated jumps to
  // the same story don't reload it. doJump reads .value and writes it on (re)load.
  loadedKey: { value: string }
  // Whether a story is currently loaded AND playable. seekToLine no-ops once a
  // story has ended, so when this is false we (re)play before seeking.
  isActive: () => boolean
  jump: Jump
}

export async function doJump(opts: DoJumpOptions): Promise<void> {
  const { stage, story, loadedKey, isActive, jump } = opts
  if (!stage) return
  if (!story?.selectedType || story.selectedChapter < 0) {
    console.warn('[live2d] doJump: no story selected in host store — ignoring jump', jump)
    return
  }

  // 1) Ensure the right story is loaded. Reload when the editor's selection
  //    changed vs. what's loaded, or when nothing is currently playable (ended).
  //    play() resolves after the first checkpoint, so the controller (and its
  //    voiceId/talkIndex maps) exist by the time we resolve the target below.
  const key = selKeyOf(story)
  if (key !== loadedKey.value || !isActive()) {
    loadedKey.value = key
    await stage.play(
      story.selectedType,
      story.selectedSort,
      story.selectedIndex,
      story.selectedChapter,
    )
  }

  // 2) Resolve the target dialog line: PREFER voiceId, FALL BACK to talkIndex.
  let line = -1
  if (jump.voiceId) line = stage.lineForVoiceId(jump.voiceId)
  if (line < 1) line = stage.lineForTalkIndex(jump.talkIndex)

  // 3) Clamp to the loaded story's range; if still unresolved, seek to the
  //    nearest in-range line and warn (never drop the jump on the floor).
  const total = stage.dialogLineCount()
  if (line < 1) {
    const nearest = Math.max(1, Math.min(jump.talkIndex + 1, total || 1))
    console.warn(
      `[live2d] doJump: could not resolve a line (voiceId=${jump.voiceId ?? 'none'} ` +
      `talkIndex=${jump.talkIndex}); seeking nearest line ${nearest}/${total}`,
    )
    line = nearest
  } else if (total) {
    line = Math.max(1, Math.min(line, total))
  }

  await stage.seekToLine(line)
}
