// Fetch the full scenario JSON for the Live2D player.
// The backend's /story/load returns a trimmed SourceTalk[]; the Live2D player
// needs the complete Unity scenario (Snippets/LayoutData/AppearCharacters/...).
// So we ask /story/json-path only for the CDN URL, then fetch the raw JSON
// through the live2d proxy (which can reach storage.sekai.best).

import { api } from '../../host'
import { proxied, EXMEANING_BASE } from '../../constants/live2d'
import type { IScenarioData } from '../../types/scenario'

export interface ScenarioLoadResult {
  scenario: IScenarioData
  scenarioId: string
  title: string
}

// Rewrite whatever CDN/source URL json-path returns onto the exmeaning full
// mirror: drop protocol+host+bucket, strip the haruki "ondemand/" (or
// "startapp/") prefix, and normalize ".asset" -> ".json".
function toExmeaning(url: string): string {
  let path = url.replace(/^https?:\/\/[^/]+\//, '')
  path = path.replace(/^sekai-(jp|cn)-assets\//, '')
  path = path.replace(/^jp-assets\//, '')
  path = path.replace(/^ondemand\//, '').replace(/^startapp\//, '')
  path = path.replace(/\.asset$/, '.json')
  return `${EXMEANING_BASE}/${path}`
}

export async function fetchScenario(
  type: string,
  sort: string,
  index: string,
  chapter: number,
  source: string,
): Promise<ScenarioLoadResult> {
  const path = await api.jsonPath(type, sort, index, chapter, source)
  if (!path.url) throw new Error('未找到该剧情的资源地址')

  const res = await fetch(proxied(toExmeaning(path.url)))
  if (!res.ok) throw new Error(`剧情 JSON 加载失败: HTTP ${res.status}`)
  const scenario = (await res.json()) as IScenarioData

  // Card-story scenario JSON often carries a broken / Japanese internal ScenarioId
  // (e.g. "★4冬弥・泉_前半") that does NOT match the on-CDN voice folder. The voice
  // clips live under the scenario ASSET base name (e.g. 012043_touya01) — the last
  // path segment of the source URL — which is what /voice/url expects. Mirror the
  // backend StoryLoad fix here so the player's card voices resolve (downstream the
  // controller reads scenario.ScenarioId when requesting each voice URL).
  if (type.includes('卡面')) {
    const base = assetBaseName(path.url)
    if (base) scenario.ScenarioId = base
  }

  return {
    scenario,
    scenarioId: scenario.ScenarioId,
    title: path.chapterTitle || path.saveTitle || scenario.ScenarioId,
  }
}

// assetBaseName extracts the scenario asset's base name (no directory, no
// extension) from its URL, e.g.
// ".../character/member/res012_no043/012043_touya01.asset" -> "012043_touya01".
function assetBaseName(url: string): string {
  let s = url.split(/[?#]/)[0]
  s = s.substring(s.lastIndexOf('/') + 1)
  const dot = s.lastIndexOf('.')
  return dot >= 0 ? s.substring(0, dot) : s
}
