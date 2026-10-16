import { SpeechSanitizer } from '../src/sanitize.ts';

const cases = [
  'Hello **world**!',
  'Use `my_list.reverse()` to reverse.',
  'See [the docs](https://x.com) for more.',
  'Costs 50% & up — about $5.',
  'Line one.\nLine two...',
  'A __bold__ word and _italic_.',
  'Under_score stays?',
  'Run npm run build && npm start',
  'Temperature: 20°C (68°F)',
  'It "quoted" it — okay',
];

for (const c of cases) {
  const s = new SpeechSanitizer();
  let out = '';
  const tokens = c.match(/.{1,3}/gs) ?? [];
  for (const t of tokens) out += s.push(t);
  out += s.flush();
  console.log(JSON.stringify(c), '\n   ->', JSON.stringify(out));
}
