// Accessors for host-provided singletons/utilities. Everything the plugin needs
// from the core app comes through window.__SEKAI_HOST__ (installed by the host
// bridge), so the plugin never imports core source directly.
declare global {
  interface Window {
    __SEKAI_HOST__?: any
  }
}

export function host() {
  const h = window.__SEKAI_HOST__
  if (!h) throw new Error('SEKAI host bridge not found — plugin loaded outside host?')
  return h
}

// The core API client (same instance the host uses).
export const api: any = new Proxy({}, {
  get(_t, prop) {
    return (host().api as any)[prop]
  },
})

// Toast helper (same notifier the core uses).
export const toast = (
  message: string,
  type?: 'success' | 'error' | 'info' | 'warn',
  duration?: number,
) => host().ui.toast(message, type, duration)

// Core stores.
export const useStoryStore = () => host().stores.story()

// Shared core components.
export const StoryNavigator = () => host().components.StoryNavigator

export {}
