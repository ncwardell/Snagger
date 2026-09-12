<script lang="ts">
  import { cn } from '$lib/cn';
  let { size = 16, class: klass = '' }: { size?: number; class?: string } = $props();
</script>

<span
  class={cn('inline-block animate-spin rounded-full border-2 border-current border-t-transparent align-middle', klass)}
  style="width: {size}px; height: {size}px;"
  aria-hidden="true"
></span>
