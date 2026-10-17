// Module resolution hook for running the TypeScript sources directly.
//
// The sources import each other with `.js` specifiers, because that is what the
// emitted ESM needs. Node's built-in type stripping loads `.ts` files as-is and
// does not rewrite those specifiers, so a test that imports a source module
// directly fails to resolve. This hook maps `./x.js` to `./x.ts` when the
// TypeScript file is what actually exists on disk.
//
// Used only by the test scripts (see package.json), never by the server.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.js') && (specifier.startsWith('./') || specifier.startsWith('../'))) {
    const asTs = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(asTs))) {
      return { url: asTs.href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
