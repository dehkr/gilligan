import { defineConfig, type Options } from 'tsup';
import pkg from './package.json';

const VERSION = JSON.stringify(pkg.version);

const baseConfig: Options = {
  entry: { rouse: 'src/index.ts' },
  format: ['esm'],
  outDir: 'dist',
  noExternal: ['alien-signals'],
  splitting: false,
  sourcemap: true,
};

export default defineConfig([
  {
    ...baseConfig,
    define: { 
      __DEV__: 'true',
      __VERSION__: VERSION,
    },
    outExtension() {
      return { js: '.js' };
    },
    dts: true,
    clean: true,
    minify: false,
  },
  {
    ...baseConfig,
    define: {
      __DEV__: 'false',
      __VERSION__: VERSION,
    },
    outExtension() {
      return { js: '.min.js' };
    },
    dts: false,
    clean: false,
    minify: true,
  },
]);
