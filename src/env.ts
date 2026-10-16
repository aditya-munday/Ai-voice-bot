/**
 * Minimal .env loader - keeps the app dependency-free for config.
 *
 * Values from the file take precedence over variables already present in the
 * environment. The checked-in .env is the deployment's source of truth for
 * model/voice selection; the process environment stays the fallback (and is how
 * secrets are normally supplied in hosts that inject them directly).
 */
import { readFileSync } from 'node:fs';

export function loadEnv(path = '.env'): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // A blank value in .env means "unset" - keep whatever the environment has.
    if (value !== '') process.env[key] = value;
  }
}
