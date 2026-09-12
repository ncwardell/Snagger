<script lang="ts">
  import { toasts } from '$lib/toast.svelte';
  import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-svelte';
  import { fly } from 'svelte/transition';

  const icons = {
    info: Info,
    success: CheckCircle2,
    warning: AlertTriangle,
    error: AlertCircle,
  } as const;
  const tones = {
    info:    'border-[var(--color-border)] text-[var(--color-fg)]',
    success: 'border-emerald-500/40 text-emerald-300',
    warning: 'border-amber-500/40 text-amber-300',
    error:   'border-rose-500/40 text-rose-300',
  } as const;
</script>

<div class="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
  {#each toasts.toasts as t (t.id)}
    {@const Icon = icons[t.kind]}
    <div
      in:fly={{ y: 12, duration: 180 }}
      out:fly={{ y: 12, duration: 140 }}
      class={`pointer-events-auto flex items-start gap-3 rounded-lg border bg-[var(--color-surface-2)] px-3.5 py-3 shadow-lg shadow-black/30 ${tones[t.kind]}`}
    >
      <Icon size={18} class="mt-0.5 shrink-0" />
      <div class="grow min-w-0">
        <div class="text-sm font-medium leading-tight">{t.title}</div>
        {#if t.description}
          <div class="mt-1 text-xs text-[var(--color-fg-muted)] leading-snug break-words">{t.description}</div>
        {/if}
      </div>
      <button class="text-[var(--color-fg-faint)] hover:text-[var(--color-fg)] -mr-1 -mt-1 p-1" onclick={() => toasts.dismiss(t.id)} aria-label="Dismiss">
        <X size={14} />
      </button>
    </div>
  {/each}
</div>
