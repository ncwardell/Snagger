<script lang="ts">
  import { cn } from '$lib/cn';
  import { ChevronDown } from 'lucide-svelte';

  type Opt = { value: string; label: string; count?: number };

  let {
    value = $bindable(''),
    options,
    placeholder = '',
    disabled = false,
    size = 'md' as 'sm' | 'md',
    class: klass = '',
    ariaLabel = undefined as string | undefined,
    onchange = undefined as ((e: Event) => void) | undefined,
  }: {
    value?: string;
    options: Opt[];
    placeholder?: string;
    disabled?: boolean;
    size?: 'sm' | 'md';
    class?: string;
    ariaLabel?: string;
    onchange?: (e: Event) => void;
  } = $props();

  const heightClass = $derived(size === 'sm' ? 'h-7 text-xs pr-7 pl-2' : 'h-9 text-sm pr-8 pl-3');
</script>

<div class={cn('relative inline-flex', klass)}>
  <select
    aria-label={ariaLabel}
    {disabled}
    bind:value
    {onchange}
    class={cn(
      'appearance-none rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] text-[var(--color-fg)] focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand-soft)] transition-colors disabled:opacity-50 w-full',
      heightClass,
    )}
  >
    {#if placeholder}
      <option value="" disabled={value !== ''}>{placeholder}</option>
    {/if}
    {#each options as opt (opt.value)}
      <option value={opt.value}>
        {opt.label}{opt.count != null ? ` (${opt.count})` : ''}
      </option>
    {/each}
  </select>
  <ChevronDown size={14} class="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--color-fg-faint)] pointer-events-none" />
</div>
