<script lang="ts">
  import { cn } from '$lib/cn';
  import type { Snippet } from 'svelte';

  let {
    value = $bindable(''),
    type = 'text',
    placeholder = '',
    disabled = false,
    autofocus = false,
    size = 'md' as 'sm' | 'md',
    class: klass = '',
    leading = undefined as Snippet | undefined,
    trailing = undefined as Snippet | undefined,
    oninput = undefined as ((e: Event) => void) | undefined,
    onkeydown = undefined as ((e: KeyboardEvent) => void) | undefined,
    onblur = undefined as ((e: FocusEvent) => void) | undefined,
    ariaLabel = undefined as string | undefined,
  }: {
    value?: string;
    type?: 'text' | 'search' | 'number' | 'url' | 'password' | 'email';
    placeholder?: string;
    disabled?: boolean;
    autofocus?: boolean;
    size?: 'sm' | 'md';
    class?: string;
    leading?: Snippet;
    trailing?: Snippet;
    oninput?: (e: Event) => void;
    onkeydown?: (e: KeyboardEvent) => void;
    onblur?: (e: FocusEvent) => void;
    ariaLabel?: string;
  } = $props();

  const heightClass = $derived(size === 'sm' ? 'h-7 text-xs' : 'h-9 text-sm');
</script>

<div class={cn(
  'inline-flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-2)] focus-within:border-[var(--color-brand)] focus-within:ring-2 focus-within:ring-[var(--color-brand-soft)] transition-colors px-2',
  heightClass,
  disabled && 'opacity-50',
  klass,
)}>
  {#if leading}<span class="text-[var(--color-fg-faint)] flex shrink-0">{@render leading()}</span>{/if}
  <input
    {type}
    {placeholder}
    {disabled}
    {autofocus}
    aria-label={ariaLabel}
    bind:value
    {oninput}
    {onkeydown}
    {onblur}
    class="grow bg-transparent outline-none border-0 text-[var(--color-fg)] placeholder:text-[var(--color-fg-faint)] min-w-0"
  />
  {#if trailing}<span class="text-[var(--color-fg-faint)] flex shrink-0">{@render trailing()}</span>{/if}
</div>
