import { sentryVitePlugin } from "@sentry/vite-plugin";
import { defineConfig } from "vite";

// Source maps are uploaded to Sentry only in CI, where SENTRY_AUTH_TOKEN is set.
// The plugin also reads SENTRY_ORG / SENTRY_PROJECT from the environment.
const uploadSourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN);

export default defineConfig({
  server: { port: 5173 },
  // Strip Sentry's tracing / session-replay / debug code paths — we use errors
  // only. https://docs.sentry.io/platforms/javascript/configuration/tree-shaking/
  define: {
    __SENTRY_DEBUG__: "false",
    __SENTRY_TRACING__: "false",
    __RRWEB_EXCLUDE_IFRAME__: "true",
    __RRWEB_EXCLUDE_SHADOW_DOM__: "true",
    __SENTRY_EXCLUDE_REPLAY_WORKER__: "true",
  },
  build: {
    target: "es2020",
    sourcemap: uploadSourceMaps ? "hidden" : false,
    rollupOptions: {
      // MapLibre is ~90% of the JS weight. Its own chunk downloads and parses in
      // parallel with the small app chunk (Vite adds a modulepreload for it), and
      // it stays cached across app-only deploys. Sentry is already a dynamic
      // import (src/sentry.ts) so it splits out on its own when the DSN is set.
      output: { manualChunks: { maplibre: ["maplibre-gl"] } },
    },
    // MapLibre's own chunk is legitimately ~800 kB and can't be trimmed without
    // a runtime lazy-load; don't warn about it on every build.
    chunkSizeWarningLimit: 850,
  },
  plugins: uploadSourceMaps
    ? [
        sentryVitePlugin({
          telemetry: false,
          release: { name: process.env.VITE_RELEASE },
          sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.js.map"] },
          errorHandler: () => {}, // never fail the build on an upload hiccup
        }),
      ]
    : [],
});
