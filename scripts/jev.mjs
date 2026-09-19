/**
 * Zero-dependency TypeSafe Jev client (Node 18+).
 *
 *   import { jev, pool, gateOk } from './jev.mjs';
 *   const { answers } = await jev(state, questions);
 *
 * Key: TYPESAFE_API_KEY from the environment, else from the file named by
 * TYPESAFE_ENV_FILE (default ~/.config/typesafe/env, lines like TYPESAFE_API_KEY=...).
 * The key is never printed.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const MODEL = process.env.TYPESAFE_MODEL ?? 'jev-1.13.0'; // pin a version, not an alias

let cachedKey;
export function loadKey() {
    if (cachedKey) return cachedKey;
    if (process.env.TYPESAFE_API_KEY) return (cachedKey = process.env.TYPESAFE_API_KEY);
    const file = process.env.TYPESAFE_ENV_FILE ?? join(homedir(), '.config/typesafe/env');
    const line = readFileSync(file, 'utf8')
        .split('\n')
        .map((l) => l.trim().replace(/^export /, ''))
        .find((l) => l.startsWith('TYPESAFE_API_KEY='));
    if (!line) throw new Error('TYPESAFE_API_KEY not found in environment or ' + file);
    return (cachedKey = line.slice('TYPESAFE_API_KEY='.length).replace(/^['"]|['"]$/g, ''));
}

/** Retry-After is delta-seconds or an HTTP date. Returns a bounded wait in ms, or null. */
export function retryAfterMs(header, now = Date.now()) {
    if (!header) return null;
    const secs = Number(header);
    const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - now;
    return Number.isFinite(ms) && ms > 0 ? Math.min(ms, 30000) : null;
}

/**
 * One logical call. Retries 429/529 with exponential backoff: `retries: 6` means up to seven
 * attempts. `timeoutMs` bounds each attempt and `deadlineMs` bounds the whole call including
 * waits. For inline production calls pass { retries: 0, timeoutMs: 1200 } and fall through to
 * today's behaviour on throw.
 * Returns latencyMs (the successful attempt), totalMs (end to end) and attempts.
 */
export async function jev(state, questions, { model = MODEL, retries = 6, timeoutMs = 30000, deadlineMs = 120000 } = {}) {
    const start = Date.now();
    for (let attempt = 0; ; attempt++) {
        const left = deadlineMs - (Date.now() - start);
        if (left <= 0) throw new Error(`Jev deadline of ${deadlineMs} ms exceeded after ${attempt} attempts`);
        const t0 = Date.now();
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: { Authorization: `Bearer ${loadKey()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, state, questions }),
            signal: AbortSignal.timeout(Math.min(timeoutMs, left)),
        });
        if ((res.status === 429 || res.status === 529) && attempt < retries) {
            const wait = retryAfterMs(res.headers.get('retry-after')) ?? 500 * 2 ** attempt;
            await new Promise((r) => setTimeout(r, wait));
            continue;
        }
        if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const data = await res.json();
        return { answers: data.answers, usage: data.usage, model: data.model, latencyMs: Date.now() - t0, totalMs: Date.now() - start, attempts: attempt + 1 };
    }
}

/** Run jobs through a small pool. The public endpoint throttles above roughly 8 parallel calls. */
export async function pool(items, worker, concurrency = 5) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('pool: concurrency must be a positive integer');
    const out = new Array(items.length);
    let next = 0;
    const run = async () => {
        while (next < items.length) {
            const i = next++;
            try {
                out[i] = await worker(items[i], i);
            } catch (e) {
                out[i] = { error: String(e.message ?? e) };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
    return out;
}

/** True when every named choice/score answer clears the gate. Nouls have no confidence; gate them yourself. */
export function gateOk(answers, ids, gate = 0.8) {
    return ids.every((id) => (answers[id]?.confidence ?? 0) >= gate);
}
