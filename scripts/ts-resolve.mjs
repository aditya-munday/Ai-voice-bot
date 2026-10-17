// Registers the resolution hook that lets tests import the TypeScript sources
// directly. See ts-hooks.mjs for what it does and why.
import { register } from 'node:module';
register('./ts-hooks.mjs', import.meta.url);
