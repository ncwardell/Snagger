<script lang="ts">
  import type { Snippet, Component } from 'svelte';

  let {
    icon = undefined as Component | undefined,
    title,
    description = undefined as string | undefined,
    action = undefined as Snippet | undefined,
  }: {
    icon?: Component;
    title: string;
    description?: string;
    action?: Snippet;
  } = $props();
</script>

<div class="flex flex-col items-center justify-center gap-3 py-16 text-center">
  {#if icon}
    {@const Icon = icon}
    <div class="grid size-12 place-items-center rounded-full bg-[var(--color-surface-2)] text-[var(--color-fg-muted)] border border-[var(--color-border)]">
      <Icon size={20} />
    </div>
  {/if}
  <div class="text-base font-medium text-[var(--color-fg)]">{title}</div>
  {#if description}
    <div class="max-w-sm text-sm text-[var(--color-fg-muted)]">{description}</div>
  {/if}
  {#if action}<div class="mt-1">{@render action()}</div>{/if}
</div>
