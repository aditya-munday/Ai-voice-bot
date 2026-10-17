/**
 * Sanitizer regression tests. The sanitizer runs on a token stream, so each case
 * is fed in three-character chunks rather than whole: that is what exercises the
 * cross-chunk state (a pending space, a half-finished word, a combining mark
 * arriving after its base letter).
 */
import { SpeechSanitizer } from '../src/sanitize.ts';

const cases: [string, string][] = [
  ['Hello **world**!', 'Hello world!'],
  ['Use `my_list.reverse()` to reverse.', 'Use my list.reverse to reverse.'],
  ['See [the docs](https://x.com) for more.', 'See the docs for more.'],
  ['Costs 50% & up — about $5.', 'Costs 50 percent and up, about 5.'],
  ['Line one.\nLine two...', 'Line one. Line two.'],
  ['A __bold__ word and _italic_.', 'A bold word and italic.'],
  ['Under_score stays?', 'Under score stays?'],
  ['Run npm run build && npm start', 'Run npm run build and npm start'],
  ['Temperature: 20°C (68°F)', 'Temperature, 20 degrees C 68 degrees F'],
  ['It "quoted" it — okay', 'It quoted it, okay'],

  // Curly quotes must attach or vanish, never be spoken as a word of their own.
  ['It’s the “many forms” of a single interface.', "It's the many forms of a single interface."],
  ['‘quoted’', 'quoted'],

  // Hyphens separate words. Dropping the mark instead of spacing it would fuse
  // the two words into one, and the model emits Unicode hyphens, not just ASCII.
  ['well-known fact', 'well known fact'],
  ['object‑oriented code', 'object oriented code'],
  ['object‐oriented code', 'object oriented code'],

  // Hindi arrives from STT as Devanagari. Combining marks must stay glued to
  // their base letter, and the danda is a sentence end, not a spoken character.
  ['सर्वर नहीं चल रहा है।', 'सर्वर नहीं चल रहा है.'],
  ['यह मेरा code है, ठीक है?', 'यह मेरा code है, ठीक है?'],
];

let failures = 0;
for (const [input, expected] of cases) {
  const sanitizer = new SpeechSanitizer();
  let out = '';
  // Three UTF-16 units at a time, so chunk boundaries land inside words and
  // between a base letter and its combining mark.
  for (const token of input.match(/.{1,3}/gs) ?? []) out += sanitizer.push(token);
  out += sanitizer.flush();

  const ok = out === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${JSON.stringify(input)}`);
  if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(out)}`);
}

console.log(`\n${cases.length - failures}/${cases.length} sanitizer checks passed`);
if (failures > 0) process.exit(1);
