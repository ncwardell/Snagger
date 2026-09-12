<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api';
  import { toasts } from '$lib/toast.svelte';
  import type { TmdbKind, TmdbTitle, TmdbTitleDetail, TmdbEpisode, CatalogVersion, Pin } from '$lib/types';
  import Input from '$lib/components/Input.svelte';
  import Button from '$lib/components/Button.svelte';
  import Badge from '$lib/components/Badge.svelte';
  import Spinner from '$lib/components/Spinner.svelte';
  import EmptyState from '$lib/components/EmptyState.svelte';
  import { Search, X, Compass, Film, Tv, Play, Pin as PinIcon, Copy, Star, ImageOff } from 'lucide-svelte';

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const errMsg = (e: unknown) => e instanceof ApiError ? e.message : String(e);

  // ---- browse state ----
  let kind = $state<TmdbKind>('movie');
  let q = $state('');
  let qDebounced = $state('');
  let cards = $state<TmdbTitle[]>([]);
  let loadingCards = $state(false);

  let qTimer: ReturnType<typeof setTimeout> | null = null;
  $effect(() => {
    const v = q;
    if (qTimer) clearTimeout(qTimer);
    qTimer = setTimeout(() => { qDebounced = v.trim(); }, 300);
    return () => { if (qTimer) clearTimeout(qTimer); };
  });

  async function loadCards() {
    loadingCards = true;
    try {
      const res = qDebounced
        ? await api.catalogSearch(qDebounced, kind, 1)
        : await api.catalogPopular(kind, 1);
      cards = res.results;
    } catch (e) {
      toasts.error('Catalog load failed', errMsg(e));
      cards = [];
    } finally { loadingCards = false; }
  }
  $effect(() => { kind; qDebounced; loadCards(); });

  // ---- detail modal state ----
  let detail = $state<TmdbTitleDetail | null>(null);
  let loadingDetail = $state(false);
  // TV episode selection
  let season = $state<number | null>(null);
  let episodes = $state<TmdbEpisode[]>([]);
  let episode = $state<number | null>(null);
  // versions
  let versions = $state<CatalogVersion[]>([]);
  let loadingVersions = $state(false);
  let pinnedIds = $state<Set<string>>(new Set());

  function pinKeyOf(p: Pin): string {
    if (p.type === 'torrentio') return `torrentio:${p.infoHash}`;
    if (p.type === 'channel') return `channel:${p.channelKey}`;
    if (p.type === 'episode') return `episode:${p.seriesKey}:${p.season}:${p.episode}`;
    return `tubi:${p.tubiId}`;
  }

  async function openTitle(card: TmdbTitle) {
    detail = null; versions = []; episodes = []; season = null; episode = null; pinnedIds = new Set();
    loadingDetail = true;
    try {
      const d = await api.catalogTitle(card.kind, card.tmdbId);
      detail = d;
      if (!d.imdbId) { toasts.error('No IMDB id for this title', 'Cannot resolve sources.'); return; }
      if (d.kind === 'movie') {
        await loadVersions();
      } else {
        // default to first season
        const first = d.seasons?.[0]?.seasonNumber ?? 1;
        await selectSeason(first);
      }
    } catch (e) {
      toasts.error('Failed to open title', errMsg(e));
    } finally { loadingDetail = false; }
  }

  async function selectSeason(n: number) {
    if (!detail) return;
    season = n; episode = null; versions = []; pinnedIds = new Set();
    try {
      episodes = await api.catalogSeason(detail.tmdbId, n);
    } catch (e) {
      episodes = [];
      toasts.error('Failed to load episodes', errMsg(e));
    }
  }

  async function selectEpisode(n: number) {
    episode = n;
    await loadVersions();
  }

  async function loadVersions() {
    if (!detail?.imdbId) return;
    loadingVersions = true;
    versions = [];
    try {
      const s = detail.kind === 'tv' ? season ?? undefined : undefined;
      const e = detail.kind === 'tv' ? episode ?? undefined : undefined;
      const [res, pins] = await Promise.all([
        api.catalogSources(detail.imdbId, { kind: detail.kind, title: detail.title, season: s, episode: e }),
        api.getPins(detail.imdbId, s, e),
      ]);
      versions = res.versions;
      pinnedIds = new Set(pins.pins.map(pinKeyOf));
    } catch (e) {
      toasts.error('Failed to load sources', errMsg(e));
    } finally { loadingVersions = false; }
  }

  async function pin(v: CatalogVersion) {
    if (!detail?.imdbId) return;
    const s = detail.kind === 'tv' ? season ?? undefined : undefined;
    const e = detail.kind === 'tv' ? episode ?? undefined : undefined;
    const isPinned = pinnedIds.has(v.id);
    try {
      await api.setPins(detail.imdbId, s ?? null, e ?? null, isPinned ? [] : [v.pin]);
      pinnedIds = isPinned ? new Set() : new Set([v.id]);
      toasts.success(isPinned ? 'Unpinned' : 'Pinned', v.label);
    } catch (err) {
      toasts.error('Pin failed', errMsg(err));
    }
  }

  function play(v: CatalogVersion) { window.open(v.playUrl, '_blank'); }

  function copyStrm() {
    if (!detail?.imdbId) return;
    const seg = detail.kind === 'tv' && season != null && episode != null ? `/${season}/${episode}` : '';
    const url = `${origin}/imdb/${detail.imdbId}${seg}`;
    navigator.clipboard.writeText(url).then(
      () => toasts.success('Copied .strm URL', url + ' (resolves the pinned version)'),
      () => toasts.error('Copy failed'),
    );
  }

  function close() { detail = null; versions = []; episodes = []; }
  function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }

  const kindTabs: { value: TmdbKind; label: string; icon: typeof Film }[] = [
    { value: 'movie', label: 'Movies', icon: Film },
    { value: 'tv',    label: 'TV',     icon: Tv },
  ];

  onMount(() => { /* effect handles initial load */ });
</script>

<svelte:window onkeydown={onKey} />

<div class="flex h-full flex-col">
  <!-- header -->
  <div class="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3">
    <div class="flex items-center gap-3">
      <h1 class="text-[15px] font-semibold tracking-tight">Catalog</h1>
      <div class="flex items-center gap-1">
        {#each kindTabs as t (t.value)}
          {@const Icon = t.icon}
          {@const active = kind === t.value}
          <button
            onclick={() => (kind = t.value)}
            class={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              active ? 'bg-[var(--color-brand-soft)] text-[var(--color-brand)]' : 'text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]'
            }`}
          >
            <Icon size={13} /> {t.label}
          </button>
        {/each}
      </div>
      <div class="ml-auto">
        <Input bind:value={q} placeholder="Search {kind === 'movie' ? 'movies' : 'shows'}…" class="w-80">
          {#snippet leading()}<Search size={14} />{/snippet}
          {#snippet trailing()}
            {#if q}<button onclick={() => (q = '')} class="text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]" aria-label="Clear"><X size={14} /></button>{/if}
          {/snippet}
        </Input>
      </div>
    </div>
    <p class="mt-1 text-xs text-[var(--color-fg-muted)]">{qDebounced ? 'Search results' : 'Popular now'} · click a title to see playable sources</p>
  </div>

  <!-- grid -->
  <div class="grow overflow-auto p-5">
    {#if loadingCards && cards.length === 0}
      <div class="flex h-40 items-center justify-center text-[var(--color-fg-muted)]"><Spinner /><span class="ml-2 text-sm">Loading…</span></div>
    {:else if cards.length === 0}
      <EmptyState icon={Compass} title="Nothing to show" description={qDebounced ? 'No results — try another search.' : 'No popular titles returned (check the TMDB API key in Settings).'} />
    {:else}
      <div class="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
        {#each cards as c (c.tmdbId)}
          <button onclick={() => openTitle(c)} class="group text-left">
            <div class="relative aspect-[2/3] overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-3)]">
              {#if c.poster}
                <img src={c.poster} alt={c.title} loading="lazy" class="size-full object-cover transition-transform group-hover:scale-105" />
              {:else}
                <div class="grid size-full place-items-center text-[var(--color-fg-faint)]"><ImageOff size={22} /></div>
              {/if}
              {#if c.voteAverage > 0}
                <span class="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded bg-black/70 px-1.5 py-0.5 text-[10px] font-medium text-white">
                  <Star size={10} class="text-yellow-400" /> {c.voteAverage.toFixed(1)}
                </span>
              {/if}
            </div>
            <div class="mt-1.5 truncate text-xs font-medium text-[var(--color-fg)]" title={c.title}>{c.title}</div>
            <div class="text-[11px] text-[var(--color-fg-faint)]">{c.year ?? ''}</div>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<!-- detail modal -->
{#if detail}
  <div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8" onclick={close} role="presentation">
    <div class="w-full max-w-3xl rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] shadow-2xl" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
      <!-- header -->
      <div class="flex gap-4 border-b border-[var(--color-border)] p-5">
        <div class="aspect-[2/3] w-28 shrink-0 overflow-hidden rounded-lg bg-[var(--color-surface-3)]">
          {#if detail.poster}<img src={detail.poster} alt={detail.title} class="size-full object-cover" />{/if}
        </div>
        <div class="min-w-0 grow">
          <div class="flex items-start gap-2">
            <h2 class="text-lg font-semibold tracking-tight">{detail.title}</h2>
            <span class="text-sm text-[var(--color-fg-muted)]">{detail.year ?? ''}</span>
            <button onclick={close} class="ml-auto text-[var(--color-fg-faint)] hover:text-[var(--color-fg)]" aria-label="Close"><X size={18} /></button>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
            {#if detail.imdbId}<code class="rounded bg-[var(--color-surface-2)] px-1.5 py-0.5 font-mono">{detail.imdbId}</code>{/if}
            {#each detail.genres.slice(0, 4) as g}<Badge tone="neutral">{g}</Badge>{/each}
            {#if detail.runtime}<span>{detail.runtime}m</span>{/if}
          </div>
          <p class="mt-2 line-clamp-3 text-sm text-[var(--color-fg-2)]">{detail.overview}</p>
          {#if detail.imdbId}
            <div class="mt-3">
              <Button variant="secondary" size="sm" onclick={copyStrm}><Copy size={13} /> Copy .strm URL</Button>
            </div>
          {/if}
        </div>
      </div>

      <!-- TV season/episode picker -->
      {#if detail.kind === 'tv'}
        <div class="border-b border-[var(--color-border)] p-4">
          <div class="flex items-center gap-2">
            <span class="text-xs font-medium text-[var(--color-fg-muted)]">Season</span>
            <select value={season} onchange={(e) => selectSeason(Number((e.currentTarget as HTMLSelectElement).value))}
              class="h-8 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] px-2 text-sm">
              {#each detail.seasons ?? [] as s}<option value={s.seasonNumber}>{s.name} ({s.episodeCount})</option>{/each}
            </select>
          </div>
          {#if episodes.length > 0}
            <div class="mt-3 flex flex-wrap gap-1.5">
              {#each episodes as ep (ep.episodeNumber)}
                <button onclick={() => selectEpisode(ep.episodeNumber)} title={ep.name}
                  class={`h-7 min-w-8 rounded-md border px-2 text-xs font-medium transition-colors ${
                    episode === ep.episodeNumber ? 'border-[var(--color-brand)] bg-[var(--color-brand-soft)] text-[var(--color-brand)]' : 'border-[var(--color-border)] text-[var(--color-fg-2)] hover:bg-[var(--color-surface-2)]'
                  }`}>E{ep.episodeNumber}</button>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <!-- versions -->
      <div class="p-4">
        <div class="mb-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-fg-faint)]">
          Sources {#if detail.kind === 'tv' && episode != null}· S{season}E{episode}{/if}
        </div>
        {#if loadingDetail || loadingVersions}
          <div class="flex h-24 items-center justify-center text-[var(--color-fg-muted)]"><Spinner /><span class="ml-2 text-sm">Resolving sources…</span></div>
        {:else if detail.kind === 'tv' && episode == null}
          <div class="py-6 text-center text-sm text-[var(--color-fg-muted)]">Pick an episode to see sources.</div>
        {:else if versions.length === 0}
          <div class="py-6 text-center text-sm text-[var(--color-fg-muted)]">No playable sources found.</div>
        {:else}
          <ul class="grid max-h-[40vh] gap-1.5 overflow-y-auto">
            {#each versions as v (v.id)}
              {@const isPinned = pinnedIds.has(v.id)}
              <li class="flex items-center gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-2)] px-3 py-2">
                <div class="min-w-0 grow">
                  <div class="truncate text-sm text-[var(--color-fg)]" title={v.label}>{v.label}</div>
                  <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--color-fg-faint)]">
                    <Badge tone="neutral">{v.source}</Badge>
                    {#if v.quality > 0}<span>q{v.quality}</span>{/if}
                    {#if isPinned}<Badge tone="brand">pinned</Badge>{/if}
                  </div>
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon" title="Play" ariaLabel="Play" onclick={() => play(v)}><Play size={14} /></Button>
                  <Button variant={isPinned ? 'subtle' : 'ghost'} size="icon" title={isPinned ? 'Unpin' : 'Pin as default'} ariaLabel="Pin" onclick={() => pin(v)}><PinIcon size={14} /></Button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    </div>
  </div>
{/if}
