// Live2D plugin entry. The host calls setup(host) after loading this bundle.
// All host singletons (Vue/router/pinia/stores/api) are reached via the bridge
// — see vite.config.ts host-shim (vue/vue-router/pinia) and ./host.ts (api,
// stores, shared components).
import Live2DPlayerPage from './components/Live2DPlayerPage.vue'
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
}

export function teardown() {
  // Route + sidebar removal handled by the host registry; nothing else persists.
}
