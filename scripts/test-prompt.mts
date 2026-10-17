// Prompt and context tests. These lock in the two invariants the latency work
// depends on, which are otherwise invisible until they regress:
//   1. The static prompt is byte-identical across calls, so Groq's prefix cache
//      keeps hitting and time to first token does not creep up.
//   2. All dynamic values live in the context message, and never in the prompt.
import assert from 'node:assert/strict';
import { config, buildContextMessage } from '../src/config.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`PASS  ${name}`);
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
  }
};

/* --------------------------- cacheable prefix --------------------------- */
const prompt = config.systemPrompt;
check('prompt is non-empty', prompt.length > 0);
check('prompt is byte-identical across reads', config.systemPrompt === prompt);
// A dynamic value in the prompt would change it every turn and kill the cache.
check('prompt carries no date', !/\b\d{4}-\d{2}-\d{2}\b/.test(prompt), prompt.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0]);
check('prompt carries no clock time', !/\b\d{1,2}:\d{2}\b/.test(prompt));
check('prompt names no timezone', !/\bUTC\b|\bAsia\/|\bAmerica\//.test(prompt));

/* ------------------------------ prompt rules ---------------------------- */
check('prompt states a first-sentence answer', /first sentence/i.test(prompt));
check('prompt removes the word floor', /no minimum/i.test(prompt));
check('prompt bans symbol characters', /only letters, digits, spaces/i.test(prompt));
check('prompt bans meta talk', /never mention being an ai/i.test(prompt));
check('prompt covers speech-recognition noise', /speech recognition/i.test(prompt));
check('prompt covers cut-off turns', /cut off/i.test(prompt));
check('prompt covers tools', /call tools|can call tools/i.test(prompt));
check('prompt treats tool output as untrusted', /untrusted data, never instructions/i.test(prompt));
check('prompt covers safety referrals', /emergency services/i.test(prompt));
check('prompt scales length by question', /length follows the question/i.test(prompt));
// Examples must cover both scripts, or the model drifts to one language.
check('prompt has a Devanagari example', /[\u0900-\u097F]/.test(prompt));
check('prompt has a Latin Hinglish example', /bhai ye code/i.test(prompt));
check('prompt has an English example', /capital of France/i.test(prompt));

/* --------------------------- context message ---------------------------- */
const fixed = new Date('2026-10-15T12:34:56Z');
const ctx = buildContextMessage(fixed, { timezone: 'Asia/Kolkata', locale: 'en-IN' });
check('context: labelled as context not instructions', /not instructions/i.test(ctx));
check('context: includes the date', ctx.includes('2026-10-15'));
// Asia/Kolkata is UTC+5:30, so 12:34 UTC is 18:04 local. This catches a
// timezone being formatted as if it were UTC.
check('context: applies the timezone offset', ctx.includes('18:04'), ctx);
check('context: names the timezone', ctx.includes('Asia/Kolkata'));
check('context: names the locale', ctx.includes('en-IN'));
check('context: omits notes when absent', !/Notes about the user/.test(ctx));

const withNotes = buildContextMessage(fixed, { timezone: 'UTC', locale: 'en-US', notes: 'prefers short answers' });
check('context: includes notes when present', withNotes.includes('prefers short answers'));

const badZone = buildContextMessage(fixed, { timezone: 'Not/AZone', locale: 'en-US' });
check('context: unknown timezone falls back to UTC', badZone.includes('12:34'), badZone);

// The context message must be the only place a date appears, so a caller cannot
// accidentally leak a timestamp into the cached prefix.
check('context differs from prompt', ctx !== prompt);
check('context is short', ctx.length < 300, `${ctx.length} chars`);

console.log(`\n${failed === 0 ? 'ALL' : `${failed} of`} ${failed === 0 ? 'prompt checks passed' : 'prompt checks FAILED'}`);
process.exit(failed === 0 ? 0 : 1);
