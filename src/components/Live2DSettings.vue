<script setup lang="ts">
import { ref } from 'vue'
import { api, toast } from '../host'
import { BACKEND_ORIGIN } from '../constants/live2d'

// Import a folder of Live2D assets (model/ + motion/ + model_list.json) into the
// app data dir. Picks a folder via the native dialog, then MOVES it into the
// local mirror so playback serves models/motions from disk (offline, no CDN).
const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__
const importing = ref(false)
async function importLive2D() {
  if (!isTauri) { toast('仅桌面版可用', 'warn'); return }
  try {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const path = await open({ directory: true, title: '选择 Live2D 素材文件夹' })
    if (!path) return
    importing.value = true
    const res = await api.importLive2D(path as string)
    toast(`已导入 ${res.moved} 项到本地`, 'success')
  } catch (e: any) {
    toast('导入失败: ' + (e?.message || '未知错误'), 'error')
  } finally {
    importing.value = false
  }
}

// Online asset auto-downloader. Triggers the Go backend to diff the CDN
// model_list against the local mirror and download whatever is missing (model
// bodies + motion data), then polls the progress endpoint. Self-contained: hits
// the backend directly (not through the host api client) so it works the same in
// dev (TCP) and packaged (custom scheme) via BACKEND_ORIGIN.
const syncing = ref(false)
const syncText = ref('')
// User-selectable number of models to download in parallel (1–50).
const concurrency = ref(5)
function clampConcurrency() {
  const n = Math.round(Number(concurrency.value) || 5)
  concurrency.value = n < 1 ? 1 : n > 50 ? 50 : n
}
async function syncLive2D() {
  if (syncing.value) return
  syncing.value = true
  syncText.value = '正在检查…'
  try {
    clampConcurrency()
    const startRes = await fetch(
      `${BACKEND_ORIGIN}/api/v1/live2d/sync?concurrency=${concurrency.value}`,
      { method: 'POST' },
    )
    if (!startRes.ok) throw new Error(`HTTP ${startRes.status}`)
    const { taskId } = await startRes.json()
    if (!taskId) throw new Error('未获得任务 ID')

    // Poll until terminal state, capped to avoid hanging forever.
    for (let i = 0; i < 3000; i++) {
      await new Promise((r) => setTimeout(r, 800))
      const pRes = await fetch(
        `${BACKEND_ORIGIN}/api/v1/live2d/sync-progress?task=${encodeURIComponent(taskId)}`,
      )
      if (!pRes.ok) continue
      const p = await pRes.json()
      const mb = ((p.bytes || 0) / 1e6).toFixed(1)
      syncText.value =
        `${p.current || 0}/${p.total || 0} 个模型 · ${mb}MB` +
        (p.currentModel ? ` · ${p.currentModel}` : '')
      if (p.status === 'done') {
        if ((p.total || 0) === 0) toast('已是最新，无新素材', 'info')
        else toast(`已更新 ${p.total} 个新模型`, 'success')
        return
      }
      if (p.status === 'error') {
        toast('下载失败: ' + (p.error || '未知错误'), 'error')
        return
      }
    }
    toast('下载超时，请稍后重试', 'warn')
  } catch (e: any) {
    toast('下载失败: ' + (e?.message || '未知错误'), 'error')
  } finally {
    syncing.value = false
    syncText.value = ''
  }
}
</script>

<template>
  <div>
    <div class="flex items-center justify-between">
      <div>
        <div class="text-sm font-medium">Live2D 依赖文件</div>
        <div class="text-xs text-[var(--color-text-secondary)] mt-0.5">把模型 / 动作素材文件夹移动到应用数据目录，此后剧情播放将优先走本地加载</div>
      </div>
      <button @click="importLive2D" :disabled="importing" class="btn btn-outline btn-sm whitespace-nowrap">
        {{ importing ? '导入中…' : '导入文件夹' }}
      </button>
    </div>

    <div class="flex items-center justify-between mt-3">
      <div>
        <div class="text-sm font-medium">在线素材库</div>
        <div class="text-xs text-[var(--color-text-secondary)] mt-0.5">从在线 CDN 检查并下载本地缺失的模型与动作数据</div>
        <div v-if="syncText" class="text-xs text-[var(--color-text-secondary)] mt-0.5">{{ syncText }}</div>
      </div>
      <div class="flex items-center gap-2">
        <label class="text-xs text-[var(--color-text-secondary)] whitespace-nowrap">同时下载文件数</label>
        <input
          type="number" min="1" max="50" step="1"
          v-model.number="concurrency" @change="clampConcurrency"
          :disabled="syncing" title="同时下载的文件数（1–50）"
          class="input input-bordered input-sm text-center"
          style="width: 4.5rem !important; flex: 0 0 auto;"
        />
        <button @click="syncLive2D" :disabled="syncing" class="btn btn-outline btn-sm whitespace-nowrap">
          {{ syncing ? '下载中…' : '检查并下载新素材' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Live2D 独有、宿主 purge 掉的类（--color-text-secondary 仍由宿主 :root 提供，这里继承） */
.mt-0\.5 { margin-top: 0.125rem; }
.mt-3 { margin-top: 0.75rem; }
.gap-2 { gap: 0.5rem; }
.text-center { text-align: center; }
.text-\[var\(--color-text-secondary\)\] { color: var(--color-text-secondary); }
</style>
