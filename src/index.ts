// Live2D plugin entry. The host calls setup(host) after loading this bundle.
// All host singletons (Vue/router/pinia/stores/api) are reached via the bridge
// — see vite.config.ts host-shim (vue/vue-router/pinia) and ./host.ts (api,
// stores, shared components).
import Live2DPlayerPage from './components/Live2DPlayerPage.vue'
import Live2DDockPanel from './components/Live2DDockPanel.vue'
import Live2DSettings from './components/Live2DSettings.vue'

const PLUGIN_ID = 'live2d'

export function setup(host: any) {
  host.registerRoute(PLUGIN_ID, {
    path: '/live2d',
    component: Live2DPlayerPage,
  })
  host.registerSidebarItem(PLUGIN_ID, {
    id: 'live2d:player',
    label: 'Live2D',
    icon: 'Drama',
    to: '/live2d',
    order: 50,
  })
  host.registerSettingsSection(PLUGIN_ID, {
    id: 'live2d:assets',
    title: 'Live2D 素材',
    component: Live2DSettings,
    order: 50,
  })
  // The DOCKED panel rendered beside the editor. The host frames the FIRST
  // registered dock panel (header/close/resize) and sizes its container, so the
  // panel just fills its parent. Teardown is handled by the host registry
  // (registry.forget clears dock panels) — nothing to undo in teardown().
  //
  // GUARDED: registerDockPanel only exists on host >= 4.2.4. Plugins auto-update
  // independently of the app, so this 1.0.7 bundle can run on an OLDER host that
  // lacks the method — calling it unguarded would throw and make the loader roll
  // back the WHOLE plugin (Live2D would vanish). On an old host we simply skip the
  // dock panel; the player route + sidebar + settings still work as before.
  if (typeof host.registerDockPanel === 'function') {
    host.registerDockPanel(PLUGIN_ID, {
      id: 'live2d:dock',
      component: Live2DDockPanel,
    })
  }
}

export function teardown() {
  // Route + sidebar removal handled by the host registry; nothing else persists.
}
