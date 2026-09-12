<script lang="ts">
  import { cn } from '$lib/cn';

  let {
    checked = $bindable(false),
    disabled = false,
    ariaLabel = undefined as string | undefined,
    onchange = undefined as ((next: boolean) => void) | undefined,
    class: klass = '',
  }: {
    checked?: boolean;
    disabled?: boolean;
    ariaLabel?: string;
    onchange?: (next: boolean) => void;
    class?: string;
  } = $props();

  function toggle() {
    if (disabled) return;
    checked = !checked;
    onchange?.(checked);
  }
</script>

<button
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={ariaLabel}
  {disabled}
  onclick={toggle}
  class={cn(
    'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors',
    checked ? 'bg-[var(--color-brand)]' : 'bg-[var(--color-surface-3)] border border-[var(--color-border)]',
    disabled && 'opacity-50 cursor-not-allowed',
    klass,
  )}
>
  <span class={cn(
    'inline-block size-4 rounded-full bg-white shadow transition-transform',
    checked ? 'translate-x-[18px]' : 'translate-x-0.5',
  )}></span>
</button>
