<script lang="ts">
  import { cn } from '$lib/cn';
  import type { Snippet } from 'svelte';

  type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
  type Size = 'sm' | 'md' | 'lg' | 'icon';

  let {
    variant = 'secondary' as Variant,
    size = 'md' as Size,
    type = 'button',
    disabled = false,
    loading = false,
    href = null as string | null,
    title = undefined as string | undefined,
    onclick = undefined as ((e: MouseEvent) => void) | undefined,
    class: klass = '',
    children,
    ariaLabel = undefined as string | undefined,
  }: {
    variant?: Variant;
    size?: Size;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    loading?: boolean;
    href?: string | null;
    title?: string;
    onclick?: (e: MouseEvent) => void;
    class?: string;
    children?: Snippet;
    ariaLabel?: string;
  } = $props();

  const base =
    'inline-flex items-center justify-center gap-2 font-medium select-none transition-colors rounded-md disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap';

  const variantClasses: Record<Variant, string> = {
    primary:   'bg-[var(--color-brand)] text-white hover:bg-[var(--color-brand-hover)]',
    secondary: 'bg-[var(--color-surface-2)] text-[var(--color-fg)] border border-[var(--color-border)] hover:border-[var(--color-border-strong)] hover:bg-[var(--color-surface-3)]',
    ghost:     'bg-transparent text-[var(--color-fg-2)] hover:bg-[var(--color-surface-2)] hover:text-[var(--color-fg)]',
    subtle:    'bg-[var(--color-brand-soft)] text-[var(--color-brand)] hover:bg-[color-mix(in_srgb,var(--color-brand)_22%,transparent)]',
    danger:    'bg-[var(--color-danger)] text-white hover:bg-[color-mix(in_srgb,var(--color-danger)_85%,black)]',
  };
  const sizeClasses: Record<Size, string> = {
    sm:   'h-7 text-xs px-2.5',
    md:   'h-9 text-sm px-3.5',
    lg:   'h-11 text-base px-5',
    icon: 'h-9 w-9 text-sm p-0',
  };
</script>

{#if href}
  <a
    {href}
    {title}
    aria-label={ariaLabel}
    aria-disabled={disabled || loading || undefined}
    class={cn(base, variantClasses[variant], sizeClasses[size], klass)}
    onclick={disabled ? (e) => e.preventDefault() : onclick}
  >
    {#if loading}<span class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"></span>{/if}
    {@render children?.()}
  </a>
{:else}
  <button
    {type}
    {title}
    aria-label={ariaLabel}
    disabled={disabled || loading}
    {onclick}
    class={cn(base, variantClasses[variant], sizeClasses[size], klass)}
  >
    {#if loading}<span class="size-3 animate-spin rounded-full border-2 border-current border-t-transparent"></span>{/if}
    {@render children?.()}
  </button>
{/if}
