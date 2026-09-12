<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api';
  import { toasts } from '$lib/toast.svelte';
  import type { Source, SourceType } from '$lib/types';
  import Button from '$lib/components/Button.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import Input from '$lib/components/Input.svelte';
  import Toggle from '$lib/components/Toggle.svelte';
  import Spinner from '$lib/components/Spinner.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { PlugZap, RefreshCw, Wifi, Trash2, Pencil, Plus, X, ChevronDown, ChevronUp } from 'lucide-svelte';

  // ---- source list ----
  let sources = $state<Source[]>([]);
  let loading = $state(false);
  let busy = $state<Record<number, string>>({});

  const errMsg = (e: unknown) => e instanceof ApiError ? e.message : String(e);

  async function load() {
    loading = true;
    try { sources = (await api.listSources()).sources; }
    catch (e) { toasts.error('Failed to load sources', errMsg(e)); }
    finally { loading = false; }
  }
  onMount(load);

  // ---- add/edit panel ----
  // null = closed, -1 = adding new, n = editing source id n
  let panelId = $state<number | null>(null);

  // form state
  let fName = $state('');
  let fType = $state<SourceType>('plutotv');
  let fEnabled = $state(true);
  // plutotv
  let fEmail = $state('');
  let fPassword = $state('');
  // xtream
  let fHost = $state('');
  let fXUser = $state('');
  let fXPass = $state('');
  let fOutput = $state<'ts' | 'm3u8'>('ts');
  let fMovies = $state(true);
  // m3u
  let fM3uUrl = $state('');
  let fEpgUrl = $state('');
  // tubi — no config fields needed

  const SOURCE_TYPES: { value: SourceType; label: string; desc: string }[] = [
    { value: 'plutotv', label: 'Pluto TV',    desc: 'Free live TV, movies & series (optional account for VOD)' },
    { value: 'tubi',    label: 'Tubi',         desc: 'Free on-demand movies & series' },
    { value: 'xtream',  label: 'Xtream Codes', desc: 'IPTV provider with Xtream Codes API' },
    { value: 'm3u',     label: 'M3U / XMLTV',  desc: 'Generic M3U playlist + optional XMLTV EPG' },
  ];

  function openAdd() {
    panelId = -1;
    fName = ''; fType = 'plutotv'; fEnabled = true;
    fEmail = ''; fPassword = '';
    fHost = ''; fXUser = ''; fXPass = ''; fOutput = 'ts'; fMovies = true;
    fM3uUrl = ''; fEpgUrl = '';
  }

  function openEdit(s: Source) {
    panelId = s.id;
    fName = s.name;
    fType = s.type;
    fEnabled = s.enabled;
    const c = s.config as Record<string, unknown>;
    // plutotv
    fEmail    = typeof c.email    === 'string' ? c.email    : '';
    fPassword = ''; // never pre-fill password (masked server-side)
    // xtream (multi-credential — edit just the first for simplicity)
    fHost   = typeof c.host   === 'string' ? c.host   : '';
    fOutput = c.output === 'm3u8' ? 'm3u8' : 'ts';
    fMovies = c.includeMovies !== false;
    const creds = Array.isArray(c.credentials) ? c.credentials as Array<Record<string,unknown>> : [];
    fXUser  = typeof creds[0]?.username === 'string' ? creds[0].username : '';
    fXPass  = ''; // masked
    // m3u
    fM3uUrl = typeof c.m3uUrl  === 'string' ? c.m3uUrl  : '';
    fEpgUrl = typeof c.epgUrl  === 'string' ? c.epgUrl  : '';
  }

  function closePanel() { panelId = null; }

  function buildConfig(): Record<string, unknown> {
    switch (fType) {
      case 'plutotv':
        return { ...(fEmail    ? { email: fEmail }    : {}),
                 ...(fPassword ? { password: fPassword } : {}) };
      case 'tubi':
        return {};
      case 'xtream':
        return { host: fHost.trim(), credentials: [{ username: fXUser.trim(), password: fXPass }],
                 output: fOutput, includeMovies: fMovies };
      case 'm3u':
        return { m3uUrl: fM3uUrl.trim(), ...(fEpgUrl.trim() ? { epgUrl: fEpgUrl.trim() } : {}) };
    }
  }

  let saving = $state(false);
  async function save() {
    if (!fName.trim()) { toasts.error('Name is required'); return; }
    if (fType === 'xtream' && !fHost.trim()) { toasts.error('Host is required for Xtream'); return; }
    if (fType === 'm3u'    && !fM3uUrl.trim()) { toasts.error('M3U URL is required'); return; }
    saving = true;
    try {
      if (panelId === -1) {
        await api.createSource({ name: fName.trim(), type: fType, config: buildConfig(), enabled: fEnabled });
        toasts.success(`Added ${fName.trim()}`);
      } else {
        await api.updateSource(panelId!, { name: fName.trim(), config: buildConfig(), enabled: fEnabled });
        toasts.success(`Updated ${fName.trim()}`);
      }
      await load();
      closePanel();
    } catch (e) {
      toasts.error(panelId === -1 ? 'Add failed' : 'Update failed', errMsg(e));
    } finally { saving = false; }
  }

  // ---- inline actions ----
  async function refreshOne(s: Source) {
    busy[s.id] = 'refresh';
    try { await api.refreshSourceByName(s.name); await load(); toasts.success(`Refreshed ${s.name}`); }
    catch (e) { toasts.error('Refresh failed', errMsg(e)); }
    finally { busy[s.id] = ''; }
  }

  async function testOne(s: Source) {
    busy[s.id] = 'test';
    try {
      const r = await api.testSource(s.id);
      if (r.ok) toasts.success(`${s.name}: reachable`, r.message);
      else       toasts.error(`${s.name}: unreachable`, r.message);
      await load();
    } catch (e) { toasts.error('Test failed', errMsg(e)); }
    finally { busy[s.id] = ''; }
  }

  async function toggleOne(s: Source, next: boolean) {
    try { await api.updateSource(s.id, { enabled: next }); await load(); }
    catch (e) { toasts.error('Update failed', errMsg(e)); await load(); }
  }

  async function deleteOne(s: Source) {
    if (!confirm(`Delete "${s.name}"?\n\nRemoves the source and all ${s.type === 'xtream' ? 'its' : ''} ingested channels. Cannot be undone.`)) return;
    busy[s.id] = 'delete';
    try {
      const r = await api.deleteSource(s.id);
      await load();
      toasts.success(`Deleted ${s.name}`, `${r.deletedChannels.toLocaleString()} channels removed`);
      if (panelId === s.id) closePanel();
    } catch (e) { toasts.error('Delete failed', errMsg(e)); }
    finally { busy[s.id] = ''; }
  }

  function statusTone(s: Source): 'success' | 'danger' | 'neutral' {
    const v = (s.lastStatus ?? '').toLowerCase();
    if (v.startsWith('error') || v.includes('fail')) return 'danger';
    if (v.startsWith('ok'))                           return 'success';
    return 'neutral';
  }

  function configSummary(s: Source): string | null {
    const c = s.config as Record<string, unknown>;
    if (s.type === 'xtream') return typeof c.host === 'string' ? c.host : null;
    if (s.type === 'm3u')    return typeof c.m3uUrl === 'string' ? c.m3uUrl : null;
    if (s.type === 'plutotv' && typeof c.email === 'string' && c.email) return c.email;
    return null;
  }

  function fmtTime(ms: number | null): string {
    if (!ms) return 'never';
    const d = Date.now() - ms, m = Math.floor(d / 60000);
    if (m < 1)  return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }

  const isAdding = $derived(panelId === -1);
  const editingSource = $derived(panelId != null && panelId > 0 ? sources.find(s => s.id === panelId) ?? null : null);
</script>

<div class="flex h-full min-h-0 flex-col">
  <!-- header -->
  <div class="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-4">
    <div class="flex items-center justify-between">
      <div>
        <h1 class="text-[15px] font-semibold tracking-tight">Sources</h1>
        <p class="mt-0.5 text-xs text-[var(--color-fg-muted)]">Connections that feed channels, EPG, and VOD into Snagger.</p>
      </div>
      <Button variant="primary" onclick={openAdd}><Plus size={14} /> Add source</Button>
    </div>
  </div>

  <div class="flex grow min-h-0 overflow-hidden">
    <!-- source list -->
    <div class="grow overflow-y-auto p-5">
      {#if loading && sources.length === 0}
        <div class="flex h-40 items-center justify-center text-[var(--color-fg-muted)]"><Spinner /><span class="ml-2 text-sm">Loading…</span></div>
      {:else if sources.length === 0}
        <EmptyState icon={PlugZap} title="No sources yet" description="Add a source to start pulling channels, EPG, and VOD.">
          {#snippet action()}<Button variant="primary" onclick={openAdd}><Plus size={14} /> Add source</Button>{/snippet}
        </EmptyState>
      {:else}
        <ul class="grid gap-2.5">
          {#each sources as s (s.id)}
            {@const acting = busy[s.id] ?? ''}
            {@const summary = configSummary(s)}
            {@const isOpen = panelId === s.id}
            <li class={`rounded-lg border bg-[var(--color-surface)] transition-colors ${isOpen ? 'border-[var(--color-brand)]' : 'border-[var(--color-border)]'} ${!s.enabled ? 'opacity-60' : ''}`}>
              <div class="flex items-center gap-3 p-4">
                <div class="grid size-9 shrink-0 place-items-center rounded-md bg-[var(--color-brand-soft)] text-[var(--color-brand)]">
                  <PlugZap size={16} />
                </div>
                <div class="grow min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="text-sm font-medium">{s.name}</span>
                    <Badge>{s.type}</Badge>
                    {#if s.lastStatus}<Badge tone={statusTone(s)}>{s.lastStatus}</Badge>{/if}
                  </div>
                  {#if summary}<div class="mt-0.5 truncate font-mono text-[11px] text-[var(--color-fg-faint)]">{summary}</div>{/if}
                  <div class="mt-0.5 text-[11px] text-[var(--color-fg-muted)]">Last refresh: {fmtTime(s.lastRefreshed)}</div>
                </div>
                <div class="flex shrink-0 items-center gap-1.5">
                  <Toggle checked={s.enabled} ariaLabel={s.enabled ? `Disable ${s.name}` : `Enable ${s.name}`} onchange={(v) => toggleOne(s, v)} />
                  <Button variant="secondary" size="sm" title="Test" disabled={!!acting} loading={acting === 'test'} onclick={() => testOne(s)}><Wifi size={13} /></Button>
                  <Button variant="secondary" size="sm" title="Refresh" disabled={!!acting} loading={acting === 'refresh'} onclick={() => refreshOne(s)}><RefreshCw size={13} /></Button>
                  <Button variant="secondary" size="sm" title="Edit" onclick={() => isOpen ? closePanel() : openEdit(s)}>
                    {#if isOpen}<ChevronUp size={13} />{:else}<Pencil size={13} />{/if}
                  </Button>
                  <Button variant="danger" size="icon" ariaLabel="Delete" title="Delete" disabled={!!acting} loading={acting === 'delete'} onclick={() => deleteOne(s)}><Trash2 size={13} /></Button>
                </div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- add/edit panel -->
    {#if panelId !== null}
      <aside class="w-96 shrink-0 border-l border-[var(--color-border)] bg-[var(--color-surface)] flex flex-col overflow-y-auto">
        <div class="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
          <h2 class="text-sm font-semibold">{isAdding ? 'Add source' : `Edit — ${editingSource?.name}`}</h2>
          <button onclick={closePanel} class="text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]" aria-label="Close"><X size={16} /></button>
        </div>

        <div class="flex flex-col gap-5 p-5">
          <!-- name -->
          <div>
            <label class="field-label">Name</label>
            <Input bind:value={fName} placeholder="My Provider" />
          </div>

          <!-- type (only when adding) -->
          {#if isAdding}
            <div>
              <label class="field-label">Type</label>
              <div class="grid gap-1.5">
                {#each SOURCE_TYPES as t (t.value)}
                  <button
                    onclick={() => fType = t.value}
                    class={`flex items-start gap-3 rounded-lg border p-3 text-left transition-colors ${fType === t.value ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)]' : 'border-[var(--color-border)] hover:bg-[var(--color-surface-2)]'}`}
                  >
                    <div class={`mt-0.5 size-3.5 shrink-0 rounded-full border-2 ${fType === t.value ? 'border-[var(--color-brand)] bg-[var(--color-brand)]' : 'border-[var(--color-border-strong)]'}`}></div>
                    <div>
                      <div class="text-sm font-medium">{t.label}</div>
                      <div class="text-[11px] text-[var(--color-fg-muted)]">{t.desc}</div>
                    </div>
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          <!-- type-specific fields -->
          {#if fType === 'plutotv'}
            <div class="grid gap-3">
              <p class="text-xs text-[var(--color-fg-muted)]">Live TV works without an account. A free Pluto account unlocks VOD playback.</p>
              <div>
                <label class="field-label">Email (optional)</label>
                <Input bind:value={fEmail} type="email" placeholder="you@example.com" />
              </div>
              <div>
                <label class="field-label">Password (optional)</label>
                <Input bind:value={fPassword} type="password" placeholder={!isAdding ? '(unchanged if blank)' : ''} />
              </div>
            </div>

          {:else if fType === 'tubi'}
            <p class="text-xs text-[var(--color-fg-muted)]">No credentials needed — Tubi uses anonymous access.</p>

          {:else if fType === 'xtream'}
            <div class="grid gap-3">
              <div>
                <label class="field-label">Server URL</label>
                <Input bind:value={fHost} type="url" placeholder="http://provider.com:8080" />
              </div>
              <div>
                <label class="field-label">Username</label>
                <Input bind:value={fXUser} placeholder="username" />
              </div>
              <div>
                <label class="field-label">Password</label>
                <Input bind:value={fXPass} type="password" placeholder={!isAdding ? '(unchanged if blank)' : ''} />
              </div>
              <div class="flex items-center gap-3">
                <Toggle bind:checked={fMovies} ariaLabel="Include movies" />
                <span class="text-sm">Include movies & series (not just live)</span>
              </div>
              <div>
                <label class="field-label">Stream format</label>
                <div class="flex gap-2">
                  {#each [['ts', 'MPEG-TS'], ['m3u8', 'HLS']] as [v, l] (v)}
                    <button onclick={() => fOutput = v as 'ts' | 'm3u8'}
                      class={`flex-1 rounded-md border py-1.5 text-xs font-medium transition-colors ${fOutput === v ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)]' : 'border-[var(--color-border)] hover:bg-[var(--color-surface-2)]'}`}>
                      {l}
                    </button>
                  {/each}
                </div>
              </div>
            </div>

          {:else if fType === 'm3u'}
            <div class="grid gap-3">
              <div>
                <label class="field-label">M3U URL</label>
                <Input bind:value={fM3uUrl} type="url" placeholder="http://…/playlist.m3u" />
              </div>
              <div>
                <label class="field-label">XMLTV EPG URL (optional)</label>
                <Input bind:value={fEpgUrl} type="url" placeholder="http://…/epg.xml" />
              </div>
            </div>
          {/if}

          <!-- enabled toggle -->
          <div class="flex items-center gap-3">
            <Toggle bind:checked={fEnabled} ariaLabel="Enable source" />
            <span class="text-sm">Enabled (include in scheduled refreshes)</span>
          </div>

          <!-- actions -->
          <div class="flex gap-2 border-t border-[var(--color-border)] pt-4">
            <Button variant="primary" onclick={save} loading={saving} class="flex-1">
              {isAdding ? 'Add source' : 'Save changes'}
            </Button>
            <Button variant="secondary" onclick={closePanel}>Cancel</Button>
          </div>
        </div>
      </aside>
    {/if}
  </div>
</div>

<style>
  .field-label {
    display: block;
    margin-bottom: 0.25rem;
    font-size: 0.6875rem;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-fg-faint);
  }
</style>
