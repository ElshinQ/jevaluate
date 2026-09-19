/**
 * Visible-text judge for QA walks. Classifies each line a person can SEE in a UI surface.
 * A regex smoke check catches the classes you already know; this catches the ones you have not
 * met yet, with a calibrated confidence.
 *
 *   import { judgeLines, summarise } from './judge-lines.mjs';
 *   const verdicts = await judgeLines(lines, { uiLanguage: 'Arabic', product: 'a business web application' });
 *   const { flagged, unsure } = summarise(verdicts);
 *
 *   CLI: node judge-lines.mjs lines.txt [English]      (one visible line per row)
 *
 * Boundaries: pass CHROME text only (labels, buttons, empty states). Never customer records or
 * model answers. Advisory: it never replaces the deterministic check, and errors never fail the walk.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jev, pool } from './jev.mjs';

const questions = (uiLanguage, product) => ({
    kind: {
        type: 'choice',
        instructions: `The state is ONE piece of text that is visible on screen to a customer of ${product}. The interface language is ${uiLanguage}. Decide what this text is.`,
        criteria: {
            customer_copy: 'Normal product text a customer is meant to read: a label, button, heading, greeting, suggestion, placeholder, status or timestamp, in the interface language. Product and brand names are fine.',
            developer_artifact: 'Something only a developer should see: a source code comment, code, a file path, a stack trace, an exception, a ticket or branch identifier, an internal note, a debug value such as undefined or [object Object].',
            untranslated_key: 'A raw translation key or template placeholder instead of words, such as some_section.some_label or {{name}}.',
            wrong_language: 'Ordinary customer copy, but written in a language other than the interface language.',
        },
    },
});

export async function judgeLines(lines, { uiLanguage = 'English', product = 'a web application', concurrency = 4 } = {}) {
    const qs = questions(uiLanguage, product);
    return pool(lines, async (line) => {
        try {
            const r = await jev(line.slice(0, 600), qs, { retries: 3 });
            return { line: line.slice(0, 160), kind: r.answers.kind.choice, confidence: r.answers.kind.confidence, latencyMs: r.latencyMs };
        } catch (e) {
            return { line: line.slice(0, 160), kind: null, confidence: null, latencyMs: 0, error: String(e.message ?? e) };
        }
    }, concurrency);
}

/** flagged = not customer copy at or above the gate. unsure = below the gate, needs a human look. */
export function summarise(verdicts, gate = 0.8) {
    return {
        judged: verdicts.filter((v) => v.kind !== null).length,
        errors: verdicts.filter((v) => v.kind === null).length,
        flagged: verdicts.filter((v) => v.kind && v.kind !== 'customer_copy' && v.confidence >= gate),
        unsure: verdicts.filter((v) => v.kind && v.confidence < gate),
    };
}

const isCli = (() => {
    try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); } catch { return false; }
})();
if (isCli) {
    if (!process.argv[2]) { console.error('usage: node judge-lines.mjs <file with one visible line per row> [interface language]'); process.exit(2); }
    const lines = [...new Set(readFileSync(process.argv[2], 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))];
    const s = summarise(await judgeLines(lines, { uiLanguage: process.argv[3] ?? 'English' }));
    console.log(`judged ${s.judged}  errors ${s.errors}  flagged ${s.flagged.length}  unsure ${s.unsure.length}`);
    for (const v of s.flagged) console.log(`FLAG   ${v.kind} c=${v.confidence.toFixed(2)}  ${v.line}`);
    for (const v of s.unsure) console.log(`UNSURE ${v.kind} c=${v.confidence.toFixed(2)}  ${v.line}`);
}
