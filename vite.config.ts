import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

// Build the Live2D plugin as a single self-contained ESM bundle.
//
// The critical constraint: the plugin runs inside the host SPA and MUST use the
// host's Vue/Pinia/router singletons (a second Vue instance breaks reactivity).
// So we resolve `vue`, `vue-router`, `pinia` to tiny virtual shim modules that
// re-export from window.__SEKAI_HOST__. Everything else (pixi, howler, the
// live2d runtime) is bundled in. The result has ZERO bare imports, so the host
// can load it via a blob URL on any WebView (no import-map needed).
const HOST_SHIMS: Record<string, string> = {
  vue: `const H = window.__SEKAI_HOST__.vue;
export default H;
export const ref = H.ref, computed = H.computed, watch = H.watch, watchEffect = H.watchEffect,
  reactive = H.reactive, shallowRef = H.shallowRef, shallowReactive = H.shallowReactive,
  toRef = H.toRef, toRefs = H.toRefs, unref = H.unref, isRef = H.isRef,
  onMounted = H.onMounted, onUnmounted = H.onUnmounted, onBeforeUnmount = H.onBeforeUnmount,
  onBeforeMount = H.onBeforeMount, onActivated = H.onActivated, onDeactivated = H.onDeactivated,
  onUpdated = H.onUpdated, onBeforeUpdate = H.onBeforeUpdate,
  nextTick = H.nextTick, defineComponent = H.defineComponent, h = H.h,
  openBlock = H.openBlock, createBlock = H.createBlock, createElementBlock = H.createElementBlock,
  createVNode = H.createVNode, createElementVNode = H.createElementVNode,
  createCommentVNode = H.createCommentVNode, createTextVNode = H.createTextVNode,
  createStaticVNode = H.createStaticVNode, renderList = H.renderList, renderSlot = H.renderSlot,
  Fragment = H.Fragment, Teleport = H.Teleport, Transition = H.Transition,
  TransitionGroup = H.TransitionGroup, KeepAlive = H.KeepAlive, Suspense = H.Suspense,
  withDirectives = H.withDirectives, withCtx = H.withCtx, withModifiers = H.withModifiers,
  withKeys = H.withKeys, vShow = H.vShow, vModelText = H.vModelText, vModelDynamic = H.vModelDynamic,
  vModelCheckbox = H.vModelCheckbox, vModelRadio = H.vModelRadio, vModelSelect = H.vModelSelect,
  toDisplayString = H.toDisplayString, normalizeClass = H.normalizeClass, normalizeStyle = H.normalizeStyle,
  normalizeProps = H.normalizeProps, mergeProps = H.mergeProps, guardReactiveProps = H.guardReactiveProps,
  resolveComponent = H.resolveComponent, resolveDirective = H.resolveDirective,
  resolveDynamicComponent = H.resolveDynamicComponent, createApp = H.createApp,
  defineAsyncComponent = H.defineAsyncComponent, markRaw = H.markRaw, toRaw = H.toRaw,
  provide = H.provide, inject = H.inject, getCurrentInstance = H.getCurrentInstance,
  useSlots = H.useSlots, useAttrs = H.useAttrs, useId = H.useId, useTemplateRef = H.useTemplateRef,
  defineProps = H.defineProps, defineEmits = H.defineEmits, defineExpose = H.defineExpose,
  pushScopeId = H.pushScopeId, popScopeId = H.popScopeId, createSlots = H.createSlots,
  isVNode = H.isVNode, cloneVNode = H.cloneVNode, useCssVars = H.useCssVars,
  setBlockTracking = H.setBlockTracking, createCommentVNode2 = H.createCommentVNode;`,
  'vue-router': `const R = window.__SEKAI_HOST__.router;
export const useRouter = () => R;
export const useRoute = () => R.currentRoute.value;
export default { useRouter, useRoute };`,
  pinia: `const H = window.__SEKAI_HOST__;
export const storeToRefs = H.vue.toRefs;
export default {};`,
}

function hostShimPlugin() {
  const PREFIX = '\0host-shim:'
  return {
    name: 'host-shim',
    // Run BEFORE vite's built-in resolver (which is enforce:'pre'); otherwise it
    // resolves 'vue' to node_modules and bundles a second Vue copy, breaking the
    // singleton (template refs silently fail: ref.i / currentRenderingInstance null).
    enforce: 'pre' as const,
    resolveId(id: string) {
      if (id in HOST_SHIMS) return PREFIX + id
      return null
    },
    load(id: string) {
      if (id.startsWith(PREFIX)) return HOST_SHIMS[id.slice(PREFIX.length)]
      return null
    },
  }
}

// In lib mode, `cssCodeSplit: false` still EMITS a separate style.css instead of
// inlining it. The .sekplugin only ships entry.js, so that CSS would never load.
// This plugin folds the emitted CSS back into entry.js as a runtime <style> inject,
// keeping the plugin a true single file.
function cssInjectPlugin() {
  return {
    name: 'css-inject',
    enforce: 'post' as const,
    generateBundle(_options: unknown, bundle: Record<string, any>) {
      let css = ''
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === 'asset' && name.endsWith('.css')) {
          css += typeof file.source === 'string' ? file.source : file.source.toString()
          delete bundle[name]
        }
      }
      if (!css) return
      const inject =
        `(function(){try{var d=document,id="sekai-plugin-live2d-css";` +
        `if(!d.getElementById(id)){var s=d.createElement("style");s.id=id;` +
        `s.textContent=${JSON.stringify(css)};d.head.appendChild(s);}}catch(e){}})();\n`
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk' && file.isEntry) {
          file.code = inject + file.code
          break
        }
      }
    },
  }
}

export default defineConfig({
  plugins: [hostShimPlugin(), vue(), cssInjectPlugin()],
  // pixi/howler reference process.env.NODE_ENV at runtime; the plugin runs in a
  // browser with no `process`, so inline the values at build time.
  define: {
    'process.env.NODE_ENV': '"production"',
    'process.env': '{}',
  },
  build: {
    outDir: 'dist',
    // Library mode: one ESM entry, no HTML, no code-splitting.
    lib: {
      entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
      formats: ['es'],
      fileName: () => 'entry.js',
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
    // Keep CSS as one asset (no per-chunk split); css-inject then folds it into entry.js.
    cssCodeSplit: false,
  },
})
