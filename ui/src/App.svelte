<script lang="ts">
  import Router from 'svelte-spa-router';
  import { wrap } from 'svelte-spa-router/wrap';
  import { replace } from 'svelte-spa-router';
  import AppShell from './layouts/AppShell.svelte';
  import Toaster from '$lib/components/Toaster.svelte';

  import Library from './routes/Library.svelte';
  import Catalog from './routes/Catalog.svelte';
  import Sources from './routes/Sources.svelte';
  import Templates from './routes/Templates.svelte';
  import Pins from './routes/Pins.svelte';
  import Settings from './routes/Settings.svelte';
  import NotFound from './routes/NotFound.svelte';

  const routes = {
    '/':          wrap({ component: Library }),
    '/library':   wrap({ component: Library }),
    '/catalog':   wrap({ component: Catalog }),
    '/sources':   wrap({ component: Sources }),
    '/templates': wrap({ component: Templates }),
    '/pins':      wrap({ component: Pins }),
    '/settings':  wrap({ component: Settings }),
    '*':          wrap({ component: NotFound }),
  };

  function conditionsFailed() { replace('/library'); }
</script>

<AppShell>
  <Router {routes} on:conditionsFailed={conditionsFailed} />
</AppShell>
<Toaster />
