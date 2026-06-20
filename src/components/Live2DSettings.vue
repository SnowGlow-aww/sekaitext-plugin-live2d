<script setup lang="ts">
import { ref } from 'vue'
import { api, toast } from '../host'

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
</script>

<template>
  <div class="flex items-center justify-between">
    <div>
      <div class="text-sm font-medium">Live2D 依赖文件</div>
      <div class="text-xs text-[var(--color-text-secondary)] mt-0.5">把模型 / 动作素材文件夹移动到应用数据目录，此后剧情播放将优先走本地加载</div>
    </div>
    <button @click="importLive2D" :disabled="importing" class="btn btn-outline btn-sm whitespace-nowrap">
      {{ importing ? '导入中…' : '导入文件夹' }}
    </button>
  </div>
</template>

<style scoped>
/* Live2D 独有、宿主 purge 掉的类（--color-text-secondary 仍由宿主 :root 提供，这里继承） */
.mt-0\.5 { margin-top: 0.125rem; }
.text-\[var\(--color-text-secondary\)\] { color: var(--color-text-secondary); }
</style>
