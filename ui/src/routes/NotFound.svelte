<script lang="ts">
  import EmptyState from '$lib/components/EmptyState.svelte';
  import Button from '$lib/components/Button.svelte';
  import { Compass } from 'lucide-svelte';
</script>

<div class="p-8">
  <EmptyState icon={Compass} title="Page not found" description="The route you opened doesn't exist (yet).">
    {#snippet action()}
      <Button variant="primary" href="#/library">Go to Library</Button>
    {/snippet}
  </EmptyState>
</div>
