import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    // globalName: 'Gilligan',
    outExtension({ format }) {
      return {
        js: format === 'esm' ? '.mjs' : '.cjs',
      };
    },
    dts: true,
    clean: true,
    minify: false,
    splitting: false,
  },
  {
    entry: {
      gilligan: 'src/index.ts',
    },
    format: ['iife'],
    globalName: 'Gilligan',
    outExtension() {
      return {
        js: '.js',
      };
    },
    clean: true,
    minify: false,
    splitting: false,
  },
  {
    entry: {
      gilligan: 'src/index.ts',
    },
    format: ['iife'],
    globalName: 'Gilligan',
    outExtension() {
      return {
        js: '.min.js',
      };
    },
    clean: true,
    minify: true,
    splitting: false,
  },
]);
