// Live2D model resolution + motion injection.
//
// Hybrid flow:
// 1. model_list.json (sekai.best) maps a costume (CostumeType / modelBase) -> modelPath.
// 2. Model body from EXMEANING: buildmodeldata.json gives the moc file name (=>
//    model3 name); fetch that model3 and rewrite moc/textures/physics to proxied
//    exmeaning URLs.
// 3. Motion data from SEKAI.BEST: BuildMotionData.json lists motion/expression
//    names (modelBase shortened until found); each becomes a full motion3.json
//    URL. exmeaning's own motion files are empty stubs, hence this split.

import {
  MODEL_LIST_URL,
  BACKEND_ORIGIN,
  proxied,
  getModelDir,
  getBuildModelDataUrl,
  getMotionListUrl,
  getMotionUrl,
  getExpressionUrl,
  type Live2DModelListElement,
} from '../../constants/live2d'

let modelListCache: Live2DModelListElement[] | null = null

export async function fetchModelList(): Promise<Live2DModelListElement[]> {
  if (modelListCache) return modelListCache
  const res = await fetch(MODEL_LIST_URL)
  if (!res.ok) throw new Error(`model_list.json fetch failed: HTTP ${res.status}`)
  modelListCache = (await res.json()) as Live2DModelListElement[]
  return modelListCache
}

export async function resolveModel(costume: string): Promise<Live2DModelListElement | null> {
  const list = await fetchModelList()
  return list.find((m) => m.modelBase === costume) ?? null
}

interface BuildModelData {
  Moc3FileName: string // e.g. "v2_20mizuki_casual_t08.moc3.bytes"
}

interface MotionList {
  motions: string[]
  expressions: string[]
}

/**
 * Fetch sekai.best's BuildMotionData (motion/expression name list). modelDir =
 * modelPath minus last segment; modelBase is shortened segment-by-segment until
 * a hit (e.g. v2_20mizuki_casual -> v2_20mizuki). Returns the lists + resolved
 * modelDir/motionBase for building clip URLs, or null.
 */
async function loadMotionList(
  modelPath: string,
  modelBase: string,
): Promise<{ list: MotionList; modelDir: string; motionBase: string } | null> {
  const modelDir = modelPath.split('/').slice(0, -1).join('/')
  let base = modelBase
  while (base.length > 0) {
    const res = await fetch(getMotionListUrl(modelDir, base))
    if (res.ok) {
      return { list: (await res.json()) as MotionList, modelDir, motionBase: base }
    }
    if (base.split('_').length <= 1) break
    base = base.split('_').slice(0, -1).join('_')
  }
  return null
}

/**
 * Build a ready-to-load model3 settings object for a costume: body from
 * exmeaning, motions/expressions from sekai.best. Returns null if not in catalog.
 */
export async function loadModelSettings(costume: string): Promise<any | null> {
  const m = await resolveModel(costume)
  if (!m) return null
  const modelPath = m.modelPath
  const dir = getModelDir(modelPath)

  // 1. exmeaning buildmodeldata. Its Moc3FileName is the AUTHORITATIVE base name for
  //    the exmeaning body files (model3/moc/textures/physics): it carries the correct
  //    REVISION (e.g. ...t08). model_list's modelFile can name an OLDER revision
  //    (...t06/t01) — preferring it outright 404s those ~100 models — but it DOES carry
  //    the correct CASE (April2026 mains: "April" in buildmodeldata, lowercase "april"
  //    files). So keep Moc3FileName's revision, and only borrow modelFile's case when
  //    the two differ by case alone.
  const bmdRes = await fetch(getBuildModelDataUrl(modelPath))
  if (!bmdRes.ok) throw new Error(`buildmodeldata fetch failed: HTTP ${bmdRes.status}`)
  const bmd = (await bmdRes.json()) as BuildModelData
  const mfBase = m.modelFile?.replace(/\.model3(\.json)?$/, '') || ''
  const mocBase = bmd.Moc3FileName.replace(/\.moc3(\.bytes)?$/, '')
  const baseName =
    !mocBase ? mfBase : mfBase && mfBase.toLowerCase() === mocBase.toLowerCase() ? mfBase : mocBase

  // 2. exmeaning model3 (standard format, no .json ext)
  const res = await fetch(proxied(`${dir}${baseName}.model3`))
  if (!res.ok) throw new Error(`model3 fetch failed: HTTP ${res.status}`)
  const json = await res.json()

  // 3. rewrite body file refs to proxied exmeaning URLs
  const ref = json.FileReferences ?? {}
  // The model3's FileReferences can declare a different CASE than the files that
  // actually exist (e.g. April2026 mains: "April" inside the model3, but the files
  // are "april"). baseName (from model_list modelFile) is the authoritative case, so
  // rebuild moc/physics from it and swap the texture path prefix — fixes both the CDN
  // fetch (online) and the local-mirror lookup (offline).
  const refBase = (ref.Moc ?? `${baseName}.moc3`).replace(/\.moc3$/, '')
  ref.Moc = proxied(`${dir}${baseName}.moc3`)
  if (Array.isArray(ref.Textures))
    ref.Textures = ref.Textures.map((t: string) =>
      proxied(dir + (refBase && refBase !== baseName ? t.replace(refBase, baseName) : t)),
    )
  if (ref.Physics) ref.Physics = proxied(`${dir}${baseName}.physics3`)

  // 4. inject motions/expressions from sekai.best (full motion3.json). Each motion
  // becomes its own group (group name = clip name) -> model.motion(name, 0).
  try {
    const mlist = await loadMotionList(modelPath, m.modelBase)
    if (mlist) {
      const { list, modelDir, motionBase } = mlist
      const motionGroups: Record<string, { File: string; FadeInTime: number; FadeOutTime: number }[]> = {}
      for (const name of list.motions || []) {
        motionGroups[name] = [{ File: getMotionUrl(modelDir, motionBase, name), FadeInTime: 0.5, FadeOutTime: 0.5 }]
      }
      // Facials are motion3.json (NOT Cubism .exp3.json), so register them as a
      // single "Expression" MOTION group (resolved by Name->index and played on a
      // parallel motion manager) and leave Cubism Expressions empty. Playing them
      // via model.expression() mis-parses the motion3 and shows a wrong face.
      const expressions = (list.expressions || []).map((name) => ({
        Name: name,
        File: getExpressionUrl(modelDir, motionBase, name),
        FadeInTime: 0.2,
        FadeOutTime: 0.2,
      }))
      ;(motionGroups as any).Expression = expressions
      ref.Motions = motionGroups
      ref.Expressions = {}
      console.info(`[live2d] "${costume}": injected ${expressions.length} expressions / ${Object.keys(motionGroups).length} motions (base=${motionBase})`)
    } else {
      console.warn(`[live2d] "${costume}": no motion list (loadMotionList returned null) — model has 0 expressions/motions`)
    }
  } catch (e) {
    console.warn(`[live2d] "${costume}": motion/expression injection threw`, e)
  }

  // Enable natural eye-blink: the mulmotion fork only creates CubismEyeBlink when
  // the model3 declares a non-empty EyeBlink parameter group, but sekai model3
  // ships it empty. Populate it with the standard eye params; the update loop only
  // blinks when no motion is active, so it never fights a playing expression.
  const groups: any[] = Array.isArray(json.Groups) ? json.Groups : []
  const eb = groups.find((g: any) => g && g.Name === 'EyeBlink' && g.Target === 'Parameter')
  if (eb) {
    if (!Array.isArray(eb.Ids) || eb.Ids.length === 0) eb.Ids = ['ParamEyeLOpen', 'ParamEyeROpen']
  } else {
    groups.push({ Target: 'Parameter', Name: 'EyeBlink', Ids: ['ParamEyeLOpen', 'ParamEyeROpen'] })
  }
  json.Groups = groups

  json.FileReferences = ref
  // All refs are already absolute proxied URLs; point the base at the backend
  // origin (not location.origin, which is tauri://localhost in the packaged app
  // and makes the loader throw "string did not match the expected pattern").
  json.url = BACKEND_ORIGIN + '/'
  return json
}
