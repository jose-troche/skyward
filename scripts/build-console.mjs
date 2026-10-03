// Bundles the console (TypeScript, Canvas 2D, no framework) into public/app.js.
import { build } from 'esbuild';

const watch = process.argv.includes('--watch');
const opts = {
  entryPoints: ['console/src/main.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !watch,
  sourcemap: true,
  outfile: 'public/app.js',
  logLevel: 'info',
};
if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(opts);
  await ctx.watch();
} else {
  await build(opts);
}
