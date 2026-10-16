import { Recorder, type RecorderState } from './recorder.js';
import { SpeechPlayer } from './speech.js';
import { Assistant } from './assistant.js';

const el = <T extends HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`missing element: ${selector}`);
  return node;
};

const talk = el<HTMLButtonElement>('#talk');
const status = el<HTMLParagraphElement>('#status');
const transcript = el<HTMLParagraphElement>('#transcript');
const answer = el<HTMLParagraphElement>('#answer');
const meter = el<HTMLDivElement>('#meter');

const recorder = new Recorder();
const speech = new SpeechPlayer();
const assistant = new Assistant(speech);

let phase: RecorderState = 'idle';

const setStatus = (text: string, tone: 'idle' | 'live' | 'think' | 'speak' | 'bad'): void => {
  status.textContent = text;
  status.dataset.tone = tone;
};

const showError = (message: string): void => {
  setStatus(message, 'bad');
};

const idleStatus = (): void => {
  if (assistant.isBusy) return;
  setStatus('Ready — hold to talk', 'idle');
};

/* ---------------------------------------------------------------- *
 * Push-to-talk
 * ---------------------------------------------------------------- */
const startListening = (): void => {
  if (phase !== 'idle') return;
  // Speaking over the assistant: drop its audio and take the turn.
  if (assistant.isBusy) assistant.cancel();
  transcript.textContent = '';
  answer.textContent = '';
  setStatus('Listening…', 'live');
  void recorder.start();
};

const stopListening = (): void => {
  // Not gated on `recording`: the first press spends time opening the microphone
  // and building the capture graph, and a release during that window must still
  // end the turn. The recorder records the release and closes it when the graph
  // is live, so the button always responds.
  recorder.stop();
};

talk.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
  startListening();
});
talk.addEventListener('pointerup', (event) => {
  event.preventDefault();
  stopListening();
});
talk.addEventListener('pointercancel', stopListening);

document.addEventListener('pointerup', stopListening);

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' || event.repeat) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  event.preventDefault();
  startListening();
});
document.addEventListener('keyup', (event) => {
  if (event.code !== 'Space') return;
  event.preventDefault();
  stopListening();
});

// Keyboard-only fallback: enter toggles recording for accessibility.
talk.addEventListener('click', (event) => {
  if (event.detail === 0) {
    if (phase === 'recording') recorder.stop();
    else startListening();
  }
});

/* ---------------------------------------------------------------- *
 * Wiring
 * ---------------------------------------------------------------- */
recorder.state.on((next) => {
  phase = next;
  talk.dataset.state = next;
  if (next === 'starting') setStatus('Opening microphone…', 'live');
  if (next === 'recording') setStatus('Listening… release to send', 'live');
  // Back to idle while the turn is still being finalized (waiting for the
  // provider's last words) — keep the live indicator up rather than flashing
  // "Ready" and then "Thinking".
  if (next === 'idle' && !recorder.isFinalizing) idleStatus();
});

recorder.transcripts.on((event) => {
  transcript.textContent = event.text;
  if (event.type === 'final') {
    setStatus('Thinking…', 'think');
    void assistant.ask(event.text);
  }
});

recorder.level.on((value) => {
  meter.style.setProperty('--level', value.toFixed(3));
});

recorder.errors.on(showError);

assistant.tokens.on((token) => {
  answer.textContent += token;
  if (!assistant.isBusy) setStatus('Thinking…', 'think');
});

assistant.speaking.on((speaking) => {
  if (speaking) setStatus('Speaking…', 'speak');
  else idleStatus();
});

assistant.errors.on(showError);

/* ------------------------------------------------ *
 * Warm start
 * ------------------------------------------------ */
// The worklet needs no user gesture, so its fetch and compile start now. It is
// the slowest step of the first press, and the press should not pay for it.
recorder.preload();

// The first gesture is the only chance to unlock audio and grant the mic, so
// use it to open every connection the assistant will need. After this, a turn
// costs no setup at all.
let primed = false;
const prime = (): void => {
  if (primed) return;
  primed = true;
  void speech.resume();
  void recorder.prime();
  document.removeEventListener('pointerdown', prime);
  document.removeEventListener('keydown', prime);
};
document.addEventListener('pointerdown', prime);
document.addEventListener('keydown', prime);

idleStatus();
