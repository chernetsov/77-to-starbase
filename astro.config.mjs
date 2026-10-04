// @ts-check
import { defineConfig } from 'astro/config';

// SITE and BASE_PATH are set by the GitHub Pages workflow (e.g. https://user.github.io + /77-to-starbase).
export default defineConfig({
  site: process.env.SITE ?? 'http://localhost:4321',
  base: process.env.BASE_PATH ?? '/',
});
