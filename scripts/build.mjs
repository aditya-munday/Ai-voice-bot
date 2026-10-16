import { build, context } from 'esbuild';

const watch = process.argv.includes('--watch');

const shared = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
};

const server = {
  ...shared,
  entryPoints: ['src/server.ts'],
  outfile: 'dist/server.js',
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
};

const client = {
  ...shared,
  entryPoints: ['src/client/main.ts'],
  outfile: 'public/main.js',
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
};

const worklet = {
  bundle: true,
  sourcemap: false,
  logLevel: 'info',
  entryPoints: ['src/client/worklet.ts'],
  outfile: 'public/pcm-worklet.js',
  platform: 'browser',
  format: 'esm',
  target: 'es2020',
};

if (watch) {
  const serverCtx = await context(server);
  const clientCtx = await context(client);
  const workletCtx = await context(worklet);
  await Promise.all([serverCtx.watch(), clientCtx.watch(), workletCtx.watch()]);
  console.log('watching for changes...');
} else {
  await Promise.all([build(server), build(client), build(worklet)]);
}
