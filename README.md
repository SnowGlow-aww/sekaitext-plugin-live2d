# SekaiText Live2D 插件

SekaiText 的 Live2D 剧情播放器插件。在编辑器内播放 Live2D 剧情，支持模型/动作/语音/特效与本地素材库。

## 开发

```bash
npm install
npm run build      # vite 构建 → dist/entry.js（单文件 ESM）
npm run pack       # 打包 → dist-plugins/live2d-<version>.sekplugin
npm run dist       # build + pack 一步到位
```

## 安装到 SekaiText

- **从文件安装**：设置 → 插件 → 从文件安装，选择 `.sekplugin`（桌面版）。
- **插件市场**：把 `.sekplugin` 上传到你的市场源，在 `index.json` 增加一条目（含 `download` URL，可选 `sha256`），客户端即可一键安装。

## 关键约束

插件运行在宿主 SPA 内，必须复用宿主的 Vue/Pinia/router 单例（再起一个 Vue 实例会破坏响应式）。`vite.config.ts` 里的 host-shim 把 `vue`/`vue-router`/`pinia` 解析为从 `window.__SEKAI_HOST__` 取的虚拟模块；pixi/howler/live2d 运行时则打包进 bundle。产物零裸 import，宿主可用 blob URL 加载。
