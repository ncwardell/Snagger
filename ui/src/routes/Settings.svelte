<script lang="ts">
  import { onMount } from 'svelte';
  import { api, ApiError } from '$lib/api';
  import { toasts } from '$lib/toast.svelte';
  import Input from '$lib/components/Input.svelte';
  import Button from '$lib/components/Button.svelte';
  import Toggle from '$lib/components/Toggle.svelte';
  import Spinner from '$lib/components/Spinner.svelte';
  import { Save } from 'lucide-svelte';

  let loading = $state(true);
  let saving = $state(false);

  let tmdb = $state('');
  let rd = $state('');
  let torrentioEndpoint = $state('');
  let proxyTorrentio = $state(false);

  async function load() {
    loading = true;
    try {
      const res = await api.getSettings();
      const s = res.settings ?? {};
      tmdb = s.tmdb_api_key ?? '';
      rd = s.rd_api_key ?? '';
      torrentioEndpoint = s.torrentio_endpoint ?? '';
      proxyTorrentio = (s.imdb_proxy_torrentio ?? '') === '1' || (s.imdb_proxy_torrentio ?? '') === 'true';
    } catch (e) {
      toasts.error('Failed to load settings', e instanceof ApiError ? e.message : String(e));
    } finally { loading = false; }
  }
  onMount(load);

  async function save() {
    saving = true;
    try {
      await api.updateSettings({
        tmdb_api_key: tmdb || null,
        rd_api_key: rd || null,
        torrentio_endpoint: torrentioEndpoint || null,
        imdb_proxy_torrentio: proxyTorrentio ? '1' : null,
      });
      toasts.success('Settings saved');
    } catch (e) {
      toasts.error('Save failed', e instanceof ApiError ? e.message : String(e));
    } finally { saving = false; }
  }
</script>

<div class="p-6 max-w-2xl">
  <div class="mb-6">
    <h1 class="text-xl font-semibold tracking-tight">Settings</h1>
    <p class="mt-1 text-sm text-[var(--color-fg-muted)]">API keys and resolver behavior. More options land in phase 2.</p>
  </div>

  {#if loading}
    <div class="flex h-40 items-center justify-center text-[var(--color-fg-muted)]"><Spinner /></div>
  {:else}
    <div class="grid gap-5">
      <div>
        <label for="tmdb" class="mb-1 block text-xs font-medium uppercase tracking-wider text-[var(--color-fg-faint)]">TMDB API key</label>
        <Input bind:value={tmdb} placeholder="v3 API key" />
        <p class="mt-1 text-xs text-[var(--color-fg-muted)]">Required for the Catalog. Free at themoviedb.org.</p>
      </div>
      <div>
        <label for="rd" class="mb-1 block text-xs font-medium uppercase tracking-wider text-[var(--color-fg-faint)]">Real-Debrid API key</label>
        <Input bind:value={rd} type="password" placeholder="optional" />
        <p class="mt-1 text-xs text-[var(--color-fg-muted)]">Returns direct playable URLs from Torrentio instead of magnet links.</p>
      </div>
      <div>
        <label for="te" class="mb-1 block text-xs font-medium uppercase tracking-wider text-[var(--color-fg-faint)]">Torrentio endpoint</label>
        <Input bind:value={torrentioEndpoint} placeholder="https://torrentio.strem.fun" />
      </div>
      <div class="flex items-center gap-3">
        <Toggle bind:checked={proxyTorrentio} ariaLabel="Proxy Torrentio results" />
        <div>
          <div class="text-sm font-medium">Proxy Torrentio results</div>
          <div class="text-xs text-[var(--color-fg-muted)]">When on, IMDB resolver routes the playback through Snagger.</div>
        </div>
      </div>

      <div class="pt-2">
        <Button variant="primary" onclick={save} loading={saving}>
          <Save size={14} /> Save changes
        </Button>
      </div>
    </div>
  {/if}
</div>
