import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  bundle: true,
  noExternal: [/@impri/],
  banner: { js: '#!/usr/bin/env node' },
  clean: true,
  minify: false,
  sourcemap: false,
  target: 'node18',
})
