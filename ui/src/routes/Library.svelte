<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { api, ApiError } from '$lib/api';
  import { templates } from '$lib/stores.svelte';
  import { toasts } from '$lib/toast.svelte';
  import type { Channel, ChannelFilters, StatsResponse, StreamType } from '$lib/types';
  import Input from '$lib/components/Input.svelte';
  import Button from '$lib/components/Button.svelte';
  import Toggle from '$lib/components/Toggle.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import Spinner from '$lib/components/Spinner.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import {
    Search, RefreshCw, RotateCcw, Pencil, X, ChevronFirst, ChevronLeft, ChevronRight, ChevronLast,
    Tv, Film, MonitorPlay, LayoutList, ImageOff,
  } from 'lucide-svelte';

  // ---- filter state ----
  let q = $state('');
  let qDebounced = $state('');
  let typeFilter = $state<StreamType | ''>('');
  let sourceFilter = $state('');
  let groupFilter = $state('');
  let page = $state(1);
  let pageSize = $state(100);

  // debounce search
  let qTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const v = q;
    if (qTimer) clearTimeout(qTimer);
    qTimer = setTimeout(() => { qDebounced = v; page = 1; }, 250);
    return () => { if (qTimer) clearTimeout(qTimer); };
  });

  // reset to page 1 when other filters change
  $effect(() => {
    typeFilter; sourceFilter; groupFilter;
    untrack(() => { page = 1; });
  });

  // ---- data state ----
  let loading = $state(false);
  let refreshing = $state(false);
  let channels = $state<Channel[]>([]);
  let total = $state(0);
  let totalPages = $state(1);
  let stats = $state<StatsResponse | null>(null);

  // selection (keys)
  let selected = $state<Set<string>>(new Set());
  let busy = $state(false);

  // editing state: which row is expanded for editing icon/group/imdb
  let editingKey = $state<string | null>(null);
  let editDraft = $state<{ name: string; icon: string; group: string; imdbId: string } | null>(null);

  const filters = $derived<ChannelFilters>({
    q: qDebounced,
    source: sourceFilter || undefined,
    type: typeFilter || undefined,
    group: groupFilter || undefined,
  });

  async function load() {
    if (templates.activeId == null) return;
    loading = true;
    try {
      const [data, st] = await Promise.all([
        api.listChannels({ ...filters, template: templates.activeId, page, pageSize }),
        api.stats(filters),
      ]);
      channels = data.channels;
      total = data.total;
      totalPages = data.totalPages;
      stats = st;
    } catch (e) {
      toasts.error('Failed to load channels', e instanceof ApiError ? e.message : String(e));
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    // re-run when any of these change
    qDebounced; typeFilter; sourceFilter; groupFilter; page; pageSize; templates.activeId;
    load();
  });

  async function refreshAll() {
    refreshing = true;
    try {
      await api.refreshAll();
      await load();
      toasts.success('Refreshed all sources');
    } catch (e) {
      toasts.error('Refresh failed', e instanceof ApiError ? e.message : String(e));
    } finally {
      refreshing = false;
    }
  }

  function effective(c: Channel) {
    return {
      name: c.override.name ?? c.name,
      icon: c.override.icon ?? c.icon,
      group: c.override.group ?? c.group,
      imdbId: c.override.imdbId,
    };
  }

  function toggleSelect(key: string) {
    const next = new Set(selected);
    if (next.has(key)) next.delete(key); else next.add(key);
    selected = next;
  }
  function isAllSelected() {
    return channels.length > 0 && channels.every(c => selected.has(c.key));
  }
  function toggleSelectAllVisible() {
    const next = new Set(selected);
    if (isAllSelected()) channels.forEach(c => next.delete(c.key));
    else channels.forEach(c => next.add(c.key));
    selected = next;
  }
  function clearSelection() { selected = new Set(); }

  // ---- inline edit ----
  function startEdit(c: Channel) {
    const eff = effective(c);
    editingKey = c.key;
    editDraft = {
      name: eff.name ?? '',
      icon: eff.icon ?? '',
      group: eff.group ?? '',
      imdbId: eff.imdbId ?? '',
    };
  }
  function cancelEdit() { editingKey = null; editDraft = null; }
  async function saveEdit(c: Channel) {
    if (!editDraft || templates.activeId == null) return;
    try {
      const patch = {
        name:   editDraft.name.trim()   === c.name   ? null : (editDraft.name.trim()   || null),
        icon:   editDraft.icon.trim()   === (c.icon ?? '')  ? null : (editDraft.icon.trim()   || null),
        group:  editDraft.group.trim()  === (c.group ?? '') ? null : (editDraft.group.trim()  || null),
        imdbId: editDraft.imdbId.trim() || null,
      };
      const res = await api.updateOverride(templates.activeId, c.key, patch);
      Object.assign(c, { override: res.override });
      channels = [...channels];
      editingKey = null;
      editDraft = null;
      toasts.success('Saved');
    } catch (e) {
      toasts.error('Save failed', e instanceof ApiError ? e.message : String(e));
    }
  }

  async function setEnabled(c: Channel, on: boolean) {
    if (templates.activeId == null) return;
    try {
      await api.updateOverride(templates.activeId, c.key, { enabled: on });
      c.enabled = on;
      channels = [...channels];
    } catch (e) {
      toasts.error('Could not update', e instanceof ApiError ? e.message : String(e));
    }
  }

  async function resetRow(c: Channel) {
    if (templates.activeId == null) return;
    try {
      await api.resetOverride(templates.activeId, c.key);
      c.override = { name: null, icon: null, group: null, imdbId: null };
      c.enabled = true;
      channels = [...channels];
      toasts.success('Reset');
    } catch (e) {
      toasts.error('Reset failed', e instanceof ApiError ? e.message : String(e));
    }
  }

  // ---- bulk ----
  async function bulkEnable(on: boolean) {
    if (templates.activeId == null || selected.size === 0) return;
    busy = true;
    try {
      await api.bulkOverride(templates.activeId, [...selected], { enabled: on });
      await load();
      toasts.success(`${on ? 'Enabled' : 'Disabled'} ${selected.size} channels`);
      clearSelection();
    } catch (e) {
      toasts.error('Bulk update failed', e instanceof ApiError ? e.message : String(e));
    } finally { busy = false; }
  }
  async function bulkReset() {
    if (templates.activeId == null || selected.size === 0) return;
    busy = true;
    try {
      await api.bulkReset(templates.activeId, [...selected]);
      await load();
      toasts.success(`Reset ${selected.size} channels`);
      clearSelection();
    } catch (e) {
      toasts.error('Reset failed', e instanceof ApiError ? e.message : String(e));
    } finally { busy = false; }
  }
  async function disableMatching() {
    if (templates.activeId == null) return;
    busy = true;
    try {
      const res = await api.bulkOverrideByFilter(templates.activeId, filters, { enabled: false });
      await load();
      toasts.success(`Disabled ${res.updated} matching channels`);
    } catch (e) {
      toasts.error('Bulk disable failed', e instanceof ApiError ? e.message : String(e));
    } finally { busy = false; }
  }

  // ---- facet helpers ----
  function setSource(s: string) { sourceFilter = sourceFilter === s ? '' : s; }
  function setGroup(g: string) { groupFilter = groupFilter === g ? '' : g; }
  function clearFilters() {
    q = ''; qDebounced = ''; sourceFilter = ''; groupFilter = ''; typeFilter = ''; page = 1;
  }

  const typeTabs: { value: StreamType | ''; label: string; icon: typeof Tv }[] = [
    { value: '',       label: 'All',     icon: LayoutList },
    { value: 'live',   label: 'Live',    icon: Tv },
    { value: 'movie',  label: 'Movies',  icon: Film },
    { value: 'series', label: 'Series',  icon: MonitorPlay },
  ];

  const startRow = $derived(total === 0 ? 0 : (page - 1) * pageSize + 1);
  const endRow = $derived(Math.min(page * pageSize, total));
  const hasActiveFilters = $derived(!!(qDebounced || sourceFilter || groupFilter || typeFilter));

  onMount(() => { /* effects handle initial load */ });
</script>

<div class="flex h-full flex-col">
  <!-- Page header -->
  <div class="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
    <div class="flex items-center gap-3 px-5 py-3">
      <h1 class="text-[15px] font-semibold tracking-tight">Library</h1>
      <span class="text-xs text-[var(--color-fg-muted)]">
        {#if total === 0 && !loading}No channels{:else}{total.toLocaleString()} channel{total === 1 ? '' : 's'}{/if}
        {#if templates.active}<span class="text-[var(--color-fg-faint)]"> · template <span class="text-[var(--color-fg-2)]">{templates.active.name}</span></span>{/if}
      </span>
      <div class="ml-auto flex items-center gap-2">
        <Input bind:value={q} placeholder="Search channels…" class="w-72">
          {#snippet leading()}<Search size={14} />{/snippet}
          {#snippet trailing()}
            {#if q}<button onclick={() => q = ''} class="text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]" aria-label="Clear search"><X size={14} /></button>{/if}
          {/snippet}
        </Input>
        <Button variant="secondary" onclick={refreshAll} loading={refreshing} title="Refresh all enabled sources">
          <RefreshCw size={14} />
          Refresh
        </Button>
      </div>
    </div>

    <!-- Type tabs -->
    <div class="flex items-center gap-1 px-3 pb-2">
      {#each typeTabs as t (t.value)}
        {@const Icon = t.icon}
        {@const active = typeFilter === t.value}
        {@const count = stats?.types.find(x => (t.value ? x.stream_type === t.value : true))}
        {@const tabCount = t.value === '' ? stats?.total : stats?.types.find(x => x.stream_type === t.value)?.n}
        <button
          onclick={() => typeFilter = t.value}
          class={`flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
            active
              ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]'
              : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]'
          }`}
        >
          <Icon size={13} />
          {t.label}
          {#if tabCount != null}<span class="text-[10px] text-[var(--color-fg-faint)]">{tabCount.toLocaleString()}</span>{/if}
        </button>
      {/each}

      {#if hasActiveFilters}
        <button onclick={clearFilters} class="ml-auto text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] inline-flex items-center gap-1">
          <X size={12} /> Clear filters
        </button>
      {/if}
    </div>
  </div>

  <!-- Bulk action bar -->
  {#if selected.size > 0}
    <div class="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-brand-soft)] px-5 py-2 text-sm">
      <span class="font-medium text-[var(--color-brand)]">{selected.size} selected</span>
      <span class="text-[var(--color-fg-muted)]">·</span>
      <Button variant="ghost" size="sm" onclick={() => bulkEnable(true)} disabled={busy}>Enable</Button>
      <Button variant="ghost" size="sm" onclick={() => bulkEnable(false)} disabled={busy}>Disable</Button>
      <Button variant="ghost" size="sm" onclick={bulkReset} disabled={busy}>Reset overrides</Button>
      <span class="ml-auto inline-flex items-center gap-2">
        <Button variant="ghost" size="sm" onclick={clearSelection}>Clear selection</Button>
      </span>
    </div>
  {/if}

  <!-- Body: facets rail + table -->
  <div class="grid grow grid-cols-[240px_1fr] min-h-0 overflow-hidden">
    <!-- Facets -->
    <aside class="overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm">
      <div class="mb-4">
        <div class="mb-2 flex items-center justify-between px-1">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-faint)]">Sources</span>
          {#if sourceFilter}<button class="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]" onclick={() => sourceFilter = ''}>clear</button>{/if}
        </div>
        <ul class="flex flex-col gap-0.5">
          {#each stats?.sources ?? [] as s (s.source)}
            {@const active = sourceFilter === s.source}
            <li>
              <button
                onclick={() => setSource(s.source)}
                class={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors ${
                  active ? 'bg-[var(--color-surface-3)] text-[var(--color-fg)]' : 'text-[var(--color-fg-2)] hover:bg-[var(--color-surface-2)]'
                }`}
              >
                <span class="truncate">{s.source}</span>
                <span class="ml-2 shrink-0 text-xs text-[var(--color-fg-faint)]">{s.n.toLocaleString()}</span>
              </button>
            </li>
          {/each}
          {#if (stats?.sources?.length ?? 0) === 0}
            <li class="px-2 py-1 text-xs text-[var(--color-fg-faint)]">No sources yet</li>
          {/if}
        </ul>
      </div>

      <div>
        <div class="mb-2 flex items-center justify-between px-1">
          <span class="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-fg-faint)]">Groups</span>
          {#if groupFilter}<button class="text-xs text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]" onclick={() => groupFilter = ''}>clear</button>{/if}
        </div>
        <ul class="flex max-h-[60vh] flex-col gap-0.5 overflow-y-auto">
          {#each (stats?.groups ?? []).slice(0, 80) as g (g.group ?? '__none__')}
            {@const label = g.group ?? '(no group)'}
            {@const active = groupFilter === (g.group ?? '')}
            <li>
              <button
                onclick={() => setGroup(g.group ?? '')}
                class={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors ${
                  active ? 'bg-[var(--color-surface-3)] text-[var(--color-fg)]' : 'text-[var(--color-fg-2)] hover:bg-[var(--color-surface-2)]'
                }`}
              >
                <span class="truncate">{label}</span>
                <span class="ml-2 shrink-0 text-xs text-[var(--color-fg-faint)]">{g.n.toLocaleString()}</span>
              </button>
            </li>
          {/each}
        </ul>
      </div>

      {#if hasActiveFilters && total > 0}
        <div class="mt-4 border-t border-[var(--color-border)] pt-3 px-1">
          <Button variant="ghost" size="sm" onclick={disableMatching} disabled={busy} class="w-full justify-center">
            Disable all matching ({total})
          </Button>
        </div>
      {/if}
    </aside>

    <!-- Table -->
    <section class="flex min-h-0 flex-col">
      <div class="grow overflow-auto">
        {#if loading && channels.length === 0}
          <div class="flex h-full items-center justify-center text-[var(--color-fg-muted)]">
            <Spinner size={20} /><span class="ml-2 text-sm">Loading…</span>
          </div>
        {:else if channels.length === 0}
          <EmptyState
            icon={Tv}
            title={hasActiveFilters ? 'No channels match' : 'No channels yet'}
            description={hasActiveFilters
              ? 'Try clearing some filters or refresh your sources.'
              : 'Add a source under Sources, then refresh.'}
          >
            {#snippet action()}
              {#if hasActiveFilters}
                <Button variant="secondary" onclick={clearFilters}>Clear filters</Button>
              {:else}
                <Button variant="primary" href="#/sources">Add a source</Button>
              {/if}
            {/snippet}
          </EmptyState>
        {:else}
          <table class="w-full text-sm">
            <thead class="sticky top-0 z-10 bg-[var(--color-surface)] text-[11px] uppercase tracking-wider text-[var(--color-fg-faint)]">
              <tr class="border-b border-[var(--color-border)]">
                <th class="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={isAllSelected()}
                    onchange={toggleSelectAllVisible}
                    aria-label="Select all visible"
                    class="accent-[var(--color-brand)]"
                  />
                </th>
                <th class="w-12 px-2 py-2"></th>
                <th class="px-2 py-2 text-left font-medium">Name</th>
                <th class="px-2 py-2 text-left font-medium">Type</th>
                <th class="px-2 py-2 text-left font-medium">Source</th>
                <th class="px-2 py-2 text-left font-medium">Group</th>
                <th class="px-2 py-2 text-left font-medium">IMDB</th>
                <th class="w-20 px-2 py-2 text-left font-medium">Enabled</th>
                <th class="w-20 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {#each channels as c (c.key)}
                {@const eff = effective(c)}
                {@const isEditing = editingKey === c.key}
                {@const overridden = !!(c.override.name || c.override.icon || c.override.group || c.override.imdbId)}
                <tr class={`border-b border-[var(--color-border)] hover:bg-[var(--color-surface-2)]/60 ${selected.has(c.key) ? 'bg-[var(--color-brand-soft)]/30' : ''} ${!c.enabled ? 'opacity-60' : ''}`}>
                  <td class="px-3 py-2 align-top">
                    <input
                      type="checkbox"
                      checked={selected.has(c.key)}
                      onchange={() => toggleSelect(c.key)}
                      aria-label="Select {eff.name}"
                      class="accent-[var(--color-brand)]"
                    />
                  </td>
                  <td class="px-2 py-2 align-top">
                    {#if eff.icon}
                      <img src={eff.icon} alt="" loading="lazy" class="size-8 rounded object-cover bg-[var(--color-surface-3)]" onerror={(e) => { (e.currentTarget as HTMLImageElement).style.display='none'; }} />
                    {:else}
                      <div class="grid size-8 place-items-center rounded bg-[var(--color-surface-3)] text-[var(--color-fg-faint)]"><ImageOff size={14} /></div>
                    {/if}
                  </td>
                  <td class="px-2 py-2 align-top">
                    {#if isEditing && editDraft}
                      <div class="flex flex-col gap-1.5">
                        <Input bind:value={editDraft.name} size="sm" placeholder="Channel name" />
                        <div class="grid grid-cols-2 gap-1.5">
                          <Input bind:value={editDraft.icon} size="sm" placeholder="Icon URL" />
                          <Input bind:value={editDraft.group} size="sm" placeholder="Group" />
                        </div>
                        <Input bind:value={editDraft.imdbId} size="sm" placeholder="IMDB id (tt…)" />
                        <div class="mt-1 flex gap-1.5">
                          <Button size="sm" variant="primary" onclick={() => saveEdit(c)}>Save</Button>
                          <Button size="sm" variant="ghost" onclick={cancelEdit}>Cancel</Button>
                        </div>
                      </div>
                    {:else}
                      <div class="flex items-center gap-2">
                        <span class="text-[var(--color-fg)] font-medium">{eff.name}</span>
                        {#if overridden}<Badge tone="brand">edited</Badge>{/if}
                      </div>
                      <div class="text-[11px] text-[var(--color-fg-faint)] font-mono">{c.channelId}</div>
                    {/if}
                  </td>
                  <td class="px-2 py-2 align-top">
                    <Badge tone={c.streamType}>{c.streamType}</Badge>
                  </td>
                  <td class="px-2 py-2 align-top text-[var(--color-fg-2)]">{c.source}</td>
                  <td class="px-2 py-2 align-top text-[var(--color-fg-2)] max-w-[180px] truncate" title={eff.group ?? ''}>
                    {eff.group ?? '—'}
                  </td>
                  <td class="px-2 py-2 align-top font-mono text-xs text-[var(--color-fg-2)]">
                    {eff.imdbId ?? '—'}
                  </td>
                  <td class="px-2 py-2 align-top">
                    <Toggle checked={c.enabled} onchange={(v) => setEnabled(c, v)} ariaLabel="Enable {eff.name}" />
                  </td>
                  <td class="px-2 py-2 align-top">
                    <div class="flex items-center justify-end gap-0.5">
                      <Button variant="ghost" size="icon" onclick={() => (isEditing ? cancelEdit() : startEdit(c))} title={isEditing ? 'Cancel' : 'Edit'} ariaLabel="Edit row">
                        {#if isEditing}<X size={14} />{:else}<Pencil size={14} />{/if}
                      </Button>
                      {#if overridden || !c.enabled}
                        <Button variant="ghost" size="icon" onclick={() => resetRow(c)} title="Reset overrides" ariaLabel="Reset row">
                          <RotateCcw size={14} />
                        </Button>
                      {/if}
                    </div>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>

      <!-- Pagination -->
      {#if total > 0}
        <div class="flex items-center gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-2 text-xs text-[var(--color-fg-muted)]">
          <span>
            <span class="text-[var(--color-fg-2)] font-medium">{startRow.toLocaleString()}–{endRow.toLocaleString()}</span>
            of {total.toLocaleString()}
          </span>
          <span class="flex items-center gap-1.5">
            Page
            <select bind:value={pageSize} class="h-7 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-1.5 text-xs">
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
              <option value={500}>500</option>
            </select>
          </span>
          <div class="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="icon" disabled={page === 1} onclick={() => page = 1} ariaLabel="First page"><ChevronFirst size={14} /></Button>
            <Button variant="ghost" size="icon" disabled={page === 1} onclick={() => page = Math.max(1, page - 1)} ariaLabel="Previous"><ChevronLeft size={14} /></Button>
            <span class="px-2 text-[var(--color-fg-2)] font-medium">{page} / {totalPages}</span>
            <Button variant="ghost" size="icon" disabled={page === totalPages} onclick={() => page = Math.min(totalPages, page + 1)} ariaLabel="Next"><ChevronRight size={14} /></Button>
            <Button variant="ghost" size="icon" disabled={page === totalPages} onclick={() => page = totalPages} ariaLabel="Last page"><ChevronLast size={14} /></Button>
          </div>
        </div>
      {/if}
    </section>
  </div>
</div>
