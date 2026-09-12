<script lang="ts">
  import { link, location } from 'svelte-spa-router';
  import {
    LibraryBig, Compass, PlugZap, LayoutPanelLeft, Pin, Settings as SettingsIcon,
    Tv2, ChevronsUpDown, Sun, Moon,
  } from 'lucide-svelte';
  import { templates, theme } from '$lib/stores.svelte';
  import Select from '$lib/components/Select.svelte';
  import Button from '$lib/components/Button.svelte';
  import type { Snippet } from 'svelte';

  let { children }: { children?: Snippet } = $props();

  const nav = [
    { href: '/library',   label: 'Library',   icon: LibraryBig },
    { href: '/catalog',   label: 'Catalog',   icon: Compass },
    { href: '/sources',   label: 'Sources',   icon: PlugZap },
    { href: '/templates', label: 'Templates', icon: LayoutPanelLeft },
    { href: '/pins',      label: 'Pins',      icon: Pin },
    { href: '/settings',  label: 'Settings',  icon: SettingsIcon },
  ];

  function isActive(href: string) {
    const loc = $location || '/';
    if (href === '/library' && (loc === '/' || loc === '')) return true;
    return loc === href || loc.startsWith(href + '/');
  }

  templates.refresh();
  theme.sync();

  const templateOpts = $derived(templates.templates.map(t => ({ value: String(t.id), label: t.name })));
  let activeIdStr = $derived(templates.activeId != null ? String(templates.activeId) : '');

  function onTemplateChange(e: Event) {
    const id = Number((e.target as HTMLSelectElement).value);
    if (id && id !== templates.activeId) templates.setActive(id);
  }
</script>

<div class="grid h-screen grid-cols-[224px_1fr] grid-rows-[56px_1fr] bg-[var(--color-bg)]">
  <!-- Sidebar -->
  <aside class="row-span-2 border-r border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col">
    <div class="flex h-14 items-center gap-2 px-4 border-b border-[var(--color-border)]">
      <div class="grid size-7 place-items-center rounded-md bg-[var(--color-brand)] text-white">
        <Tv2 size={16} />
      </div>
      <span class="text-[15px] font-semibold tracking-tight">Snagger</span>
    </div>

    <nav class="flex-1 overflow-y-auto p-2">
      {#each nav as item (item.href)}
        {@const Icon = item.icon}
        {@const active = isActive(item.href)}
        <a
          href={'#' + item.href}
          use:link
          class={`group flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors ${
            active
              ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]'
              : 'text-[var(--color-fg-2)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]'
          }`}
        >
          <Icon size={16} />
          {item.label}
        </a>
      {/each}
    </nav>

    <div class="border-t border-[var(--color-border)] p-3 flex items-center justify-between gap-2">
      <span class="text-[11px] uppercase tracking-wider text-[var(--color-fg-faint)]">v0.2</span>
      <Button variant="ghost" size="icon" onclick={() => theme.toggle()} ariaLabel="Toggle theme">
        {#if theme.mode === 'dark'}<Sun size={14} />{:else}<Moon size={14} />{/if}
      </Button>
    </div>
  </aside>

  <!-- Top bar -->
  <header class="col-start-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 flex items-center gap-3">
    <div class="flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
      <ChevronsUpDown size={14} />
      <span>Template</span>
    </div>
    <Select
      bind:value={activeIdStr}
      options={templateOpts}
      onchange={onTemplateChange}
      ariaLabel="Active template"
      class="min-w-[180px]"
    />
    <div class="ml-auto flex items-center gap-2 text-xs text-[var(--color-fg-faint)]">
      <kbd class="rounded border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--color-fg-muted)]">⌘K</kbd>
      <span>coming soon</span>
    </div>
  </header>

  <!-- Main -->
  <main class="col-start-2 overflow-y-auto min-h-0">
    {@render children?.()}
  </main>
</div>
