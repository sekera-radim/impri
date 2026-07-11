import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // node:crypto is a built-in — mark it external so tsup doesn't try to bundle it.
  external: ['node:crypto'],
})
