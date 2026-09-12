import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  resolve: {
    alias: {
      $lib: path.resolve(here, 'src/lib'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api':       'http://localhost:3000',
      '/playlist.m3u': 'http://localhost:3000',
      '/playlists': 'http://localhost:3000',
      '/epg.xml':   'http://localhost:3000',
      '/epg':       'http://localhost:3000',
      '/imdb':      'http://localhost:3000',
      '/stream':    'http://localhost:3000',
      '/stream-raw':'http://localhost:3000',
      '/v':         'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
});
