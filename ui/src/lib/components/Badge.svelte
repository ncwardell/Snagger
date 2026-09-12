<script lang="ts">
  import { cn } from '$lib/cn';
  import type { Snippet } from 'svelte';

  type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'live' | 'movie' | 'series';

  let {
    tone = 'neutral' as Tone,
    class: klass = '',
    children,
  }: { tone?: Tone; class?: string; children?: Snippet } = $props();

  const tones: Record<Tone, string> = {
    neutral: 'bg-[var(--color-surface-3)] text-[var(--color-fg-2)] border-[var(--color-border)]',
    brand:   'bg-[var(--color-brand-soft)] text-[var(--color-brand)] border-transparent',
    success: 'bg-emerald-500/15 text-emerald-400 border-transparent',
    warning: 'bg-amber-500/15 text-amber-400 border-transparent',
    danger:  'bg-rose-500/15 text-rose-400 border-transparent',
    live:    'bg-rose-500/15 text-rose-300 border-transparent',
    movie:   'bg-sky-500/15 text-sky-300 border-transparent',
    series:  'bg-violet-500/15 text-violet-300 border-transparent',
  };
</script>

<span class={cn(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide',
  tones[tone],
  klass,
)}>
  {@render children?.()}
</span>
