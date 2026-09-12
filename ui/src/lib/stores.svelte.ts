import { api, ApiError } from './api';
import { toasts } from './toast.svelte';
import type { Template } from './types';

class TemplateStore {
  templates = $state<Template[]>([]);
  activeId = $state<number | null>(null);
  loading = $state(false);

  active = $derived(this.templates.find(t => t.id === this.activeId) ?? null);

  async refresh() {
    this.loading = true;
    try {
      const { templates, activeId } = await api.listTemplates();
      this.templates = templates;
      this.activeId = activeId;
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Failed to load templates';
      toasts.error('Templates', msg);
    } finally {
      this.loading = false;
    }
  }

  async setActive(id: number) {
    try {
      await api.setActiveTemplate(id);
      this.activeId = id;
      toasts.success('Active template changed');
    } catch (e) {
      toasts.error('Could not switch template', e instanceof ApiError ? e.message : String(e));
    }
  }
}

export const templates = new TemplateStore();

class ThemeStore {
  mode = $state<'dark' | 'light'>(this.load());

  private load(): 'dark' | 'light' {
    if (typeof window === 'undefined') return 'dark';
    const stored = localStorage.getItem('snagger.theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  toggle() {
    this.mode = this.mode === 'dark' ? 'light' : 'dark';
    localStorage.setItem('snagger.theme', this.mode);
    document.documentElement.classList.toggle('dark', this.mode === 'dark');
  }
  sync() {
    document.documentElement.classList.toggle('dark', this.mode === 'dark');
  }
}

export const theme = new ThemeStore();
