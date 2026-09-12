<script lang="ts">
  import { templates } from '$lib/stores.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import Button from '$lib/components/Button.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { LayoutPanelLeft, Copy } from 'lucide-svelte';
  import { toasts } from '$lib/toast.svelte';

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => toasts.success('Copied', text),
      () => toasts.error('Copy failed'),
    );
  }
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
</script>

<div class="p-6">
  <div class="mb-6">
    <h1 class="text-xl font-semibold tracking-tight">Templates</h1>
    <p class="mt-1 text-sm text-[var(--color-fg-muted)]">Curated views of your channel library. Each one produces its own M3U + EPG.</p>
  </div>

  {#if templates.templates.length === 0}
    <EmptyState icon={LayoutPanelLeft} title="No templates" />
  {:else}
    <ul class="grid gap-3">
      {#each templates.templates as t (t.id)}
        {@const isActive = t.id === templates.activeId}
        {@const m3u = `${origin}/playlists/${encodeURIComponent(t.name)}.m3u`}
        {@const epg = `${origin}/epg/${encodeURIComponent(t.name)}.xml`}
        <li class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">{t.name}</span>
            {#if isActive}<Badge tone="brand">active</Badge>{/if}
            {#if t.proxy_mode}<Badge>proxied</Badge>{:else}<Badge tone="neutral">direct</Badge>{/if}
            {#if !isActive}
              <Button variant="ghost" size="sm" onclick={() => templates.setActive(t.id)}>Set active</Button>
            {/if}
          </div>
          <div class="mt-3 grid gap-2 text-xs">
            <div class="flex items-center gap-2">
              <span class="w-12 text-[var(--color-fg-faint)]">M3U</span>
              <code class="grow truncate rounded bg-[var(--color-surface-2)] px-2 py-1 font-mono text-[var(--color-fg-2)]">{m3u}</code>
              <Button variant="ghost" size="icon" onclick={() => copy(m3u)} ariaLabel="Copy M3U URL"><Copy size={13} /></Button>
            </div>
            <div class="flex items-center gap-2">
              <span class="w-12 text-[var(--color-fg-faint)]">EPG</span>
              <code class="grow truncate rounded bg-[var(--color-surface-2)] px-2 py-1 font-mono text-[var(--color-fg-2)]">{epg}</code>
              <Button variant="ghost" size="icon" onclick={() => copy(epg)} ariaLabel="Copy EPG URL"><Copy size={13} /></Button>
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="mt-6 rounded-md border border-dashed border-[var(--color-border)] p-4 text-xs text-[var(--color-fg-muted)]">
    Full template editor (clone, rename, per-template proxy mode, per-export enable/disable) lands in phase 2.
  </div>
</div>
