/**
 * Jev-driven browser loop. Requires: npm i -D @playwright/test && npx playwright install chromium
 *
 * The model never sees pixels and never writes prose. Each step the harness captures a compact
 * indexed text state of the page, Jev returns one combined `move` choice plus a `goal_reached`
 * noul, and the harness executes the move only when confidence clears the gate. Below the gate
 * the loop stops for human review.
 *
 *   node browser-loop.mjs --url http://localhost:8000/login \
 *     --goal "Log in as owner@example.test with password 'password', then open the contacts page." \
 *     [--out jev-run] [--max-steps 12] [--gate 0.8]
 *
 * SAFETY. Run it against a scratch or staging instance with throwaway credentials only.
 * - Typeable values come from the goal (quoted literals and email addresses). They never leave the
 *   machine: the model sees opaque placeholders (<v0>, <v1>) in the goal, in the options and in field
 *   values, and the trace stores the same placeholders.
 * - Everything else visible on the page (labels, other field values, the path of the URL) IS sent to
 *   the API and written to the trace. Do not point this at pages showing real customer data.
 * - The deny-list is a backstop, not a guarantee. It knows a few English and Arabic words.
 * Output (mode 0700 directory, 0600 files): trace.jsonl, verdict.json, step-NN.png.
 */
import { chromium } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { jev } from './jev.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
}, []));

const fail = (msg) => { console.error(msg); process.exit(2); };
if (typeof args.url !== 'string' || typeof args.goal !== 'string') fail('usage: --url <start url> --goal "<goal sentence>" [--out dir] [--max-steps n] [--gate 0..1]');
const START_URL = args.url;
const OUT = path.resolve(typeof args.out === 'string' ? args.out : 'jev-run');
const MAX_STEPS = Number(args['max-steps'] ?? 12);
const GATE = Number(args.gate ?? 0.8);
if (!Number.isFinite(GATE) || GATE < 0 || GATE > 1) fail('--gate must be a number between 0 and 1');
if (!Number.isInteger(MAX_STEPS) || MAX_STEPS < 1) fail('--max-steps must be a positive integer');

const SELECTOR = 'a, button, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"]';
const FILL_TYPES = new Set(['text', 'email', 'password', 'search', 'tel', 'url', 'number']);
const CLICK_INPUT_TYPES = new Set(['submit', 'button', 'checkbox', 'radio', 'image']);
const DENY_CLICK = [
    /\b(delete|remove|destroy|erase|sign ?out|log ?out|pay now|purchase|buy now|place order|confirm order|cancel subscription|deactivate)\b/i,
    /حذف|إزالة|ازالة|تسجيل الخروج|ادفع|الدفع الآن|شراء|تأكيد الطلب|إلغاء الاشتراك/,
];
const SKIP_INSIDE = '#phpdebugbar, .phpdebugbar, [class*="debugbar"], [data-debugbar], [data-dev-tools]';

// Secret values stay local. The model and the trace only ever see <v0>, <v1>, <v2>.
const CANDIDATES = [];
const GOAL = args.goal.replace(/'([^']+)'|"([^"]+)"|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (whole, a, b, c) => {
    const v = (a ?? b ?? c ?? '').trim();
    if (!v) return whole;
    let i = CANDIDATES.indexOf(v);
    if (i === -1 && CANDIDATES.length < 3) i = CANDIDATES.push(v) - 1;
    return i === -1 ? whole : `<v${i}>`;
});
if (CANDIDATES.length === 0) console.warn('note: the goal names no typeable values (quote them or use an email address), so only click moves will be offered.');
const redact = (s) => CANDIDATES.reduce((t, v, i) => t.split(v).join(`<v${i}>`), String(s ?? ''));
const safeUrl = (u) => { try { const x = new URL(u); return x.origin + x.pathname; } catch { return '(unparseable url)'; } };

const kindOf = (e) => (e.tag === 'textarea' || (e.tag === 'input' && FILL_TYPES.has(e.type)) ? 'fill'
    : e.tag === 'select' ? 'none'
        : e.tag === 'input' && !CLICK_INPUT_TYPES.has(e.type) ? 'none' : 'click');
const describe = (e) => `${e.tag}${e.type ? ` type=${e.type}` : ''}${e.name ? ` name=${e.name}` : ''} "${e.label}"${e.current ? ` current_value="${e.current}"` : ' (empty)'}`;

async function readElement(handle) {
    return handle.evaluate((e) => {
        const tag = e.tagName.toLowerCase();
        const label = e.getAttribute('aria-label') ?? e.getAttribute('placeholder') ?? e.labels?.[0]?.textContent?.trim() ?? e.textContent ?? '';
        const isField = tag === 'input' || tag === 'textarea';
        return {
            tag,
            type: tag === 'input' ? (e.getAttribute('type') ?? 'text').toLowerCase() : null,
            name: e.getAttribute('name') ?? '',
            label: label.trim().replace(/\s+/g, ' ').slice(0, 60),
            // never echo a password field's content back into the payload
            current: !isField ? '' : e.type === 'password' ? (e.value ? '(filled)' : '') : String(e.value ?? '').trim().slice(0, 40),
        };
    });
}

async function captureState(page, stepLog) {
    await page.waitForTimeout(650);
    const elements = [];
    const handles = await page.locator(SELECTOR).elementHandles();
    for (const handle of handles.slice(0, 60)) {
        if (elements.length >= 25) break;
        if (!(await handle.isVisible().catch(() => false))) continue;
        if (await handle.evaluate((e, sel) => !!e.closest(sel), SKIP_INSIDE).catch(() => false)) continue;
        const info = await readElement(handle).catch(() => null);
        if (!info) continue;
        const el = { idx: elements.length + 1, handle, ...info, label: redact(info.label), current: redact(info.current) };
        elements.push(el);
    }
    const lines = elements.map((e) => `[${e.idx}] ${describe(e)}`);
    const stateText = [
        `Goal: ${GOAL}`,
        `Typeable values allowed for fill: ${CANDIDATES.map((_, i) => `<v${i}>`).join(', ') || 'none'}. They are placeholders for real values the goal refers to.`,
        `URL: ${safeUrl(page.url())}`,
        `Page title: ${redact(await page.title().catch(() => ''))}`,
        'Interactive elements:',
        ...lines,
        stepLog.length ? `Steps taken so far: ${stepLog.map((s) => `${s.action} -> ${s.outcome}`).join('; ')}` : 'No steps taken yet.',
    ].join('\n');
    return { stateText, elements, fingerprint: `${safeUrl(page.url())}\n${lines.join('\n')}` };
}

function buildQuestions(elements) {
    // One complete move per option. Separate action/target/value questions split the
    // probability mass and never clear the gate; whole-move statements calibrate.
    const criteria = {};
    for (const e of elements) {
        const kind = kindOf(e);
        if (kind === 'fill') CANDIDATES.forEach((_, i) => { criteria[`fill_${e.idx}_v${i}`] = `Type the value <v${i}> into element [${e.idx}] ${describe(e)}`; });
        if (kind === 'click') criteria[`click_${e.idx}`] = `Click element [${e.idx}] ${describe(e)}`;
    }
    criteria.done = 'The goal is already fully reached; no further move is needed.';
    criteria.stuck = 'No listed move makes progress toward the goal.';
    return {
        move: {
            type: 'choice',
            instructions: 'You drive a browser one step at a time toward the goal in the state. Pick the single best next move. Each criterion is one complete move; prefer a move whose target field is empty or needs its stated value. Typing into a field that already holds that exact value is wasted. Do not repeat a step that was already taken unless the page changed.',
            criteria,
        },
        goal_reached: {
            type: 'noul',
            instructions: 'Looking at the current state only: is the goal already fully reached? 1 means yes, 0 means no.',
        },
    };
}

/** Nothing is executed unless the whole response is well formed and the move is one we offered. */
function validate(answers, questions) {
    const move = answers?.move?.choice;
    const conf = answers?.move?.confidence;
    const goalP = answers?.goal_reached?.noul;
    if (typeof move !== 'string' || !Object.hasOwn(questions.move.criteria, move)) return null;
    if (!Number.isFinite(conf) || !Number.isFinite(goalP)) return null;
    return { move, conf, goalP };
}

async function execute(page, elements, move) {
    const fill = move.match(/^fill_(\d+)_v(\d+)$/);
    const click = move.match(/^click_(\d+)$/);
    const el = elements.find((e) => e.idx === Number((fill ?? click)?.[1]));
    if (!el) return 'no-such-element';
    // The page may have changed while we waited for the API. Act on the captured handle, and only
    // if it is still the element the model was shown.
    const now = await readElement(el.handle).catch(() => null);
    if (!now || now.tag !== el.tag || now.type !== el.type || now.name !== el.name || redact(now.label) !== el.label) return 'page-changed';
    if (fill) {
        const value = CANDIDATES[Number(fill[2])];
        if (value === undefined || kindOf(el) !== 'fill') return 'invalid-move';
        await el.handle.fill(value);
        await page.waitForTimeout(150);
        return `filled <v${fill[2]}> into [${el.idx}]`;
    }
    if (kindOf(el) !== 'click') return 'invalid-move';
    if (DENY_CLICK.some((re) => re.test(el.label))) return 'denied';
    await el.handle.click();
    await page.waitForTimeout(1500);
    return 'clicked';
}

fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
const writeFile = (name, data) => fs.writeFileSync(path.join(OUT, name), data, { mode: 0o600 });
const tracePath = path.join(OUT, 'trace.jsonl');
writeFile('trace.jsonl', '');
const log = (row) => fs.appendFileSync(tracePath, JSON.stringify(row) + '\n');

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const stepLog = [];
const totals = { steps: 0, jevCalls: 0, inputTokens: 0, jevMs: 0 };
let verdict = 'incomplete';
let last = null; // { move, fingerprint } of the previous executed step

try {
    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (let step = 1; step <= MAX_STEPS; step++) {
        const { stateText, elements, fingerprint } = await captureState(page, stepLog);
        const questions = buildQuestions(elements);
        const call = await jev(stateText, questions);
        totals.jevCalls += 1;
        totals.inputTokens += call.usage?.input_tokens ?? 0;
        totals.jevMs += call.latencyMs;
        await page.screenshot({ path: path.join(OUT, `step-${String(step).padStart(2, '0')}.png`) }).catch(() => {});
        const row = { step, url: safeUrl(page.url()), state: stateText, answers: call.answers, model: call.model, latencyMs: call.latencyMs, tokens: call.usage };
        const stop = (v, msg) => { verdict = v; log({ ...row, outcome: v }); console.log(`step ${step}: ${msg ?? v}`); };

        const ok = validate(call.answers, questions);
        if (!ok) { stop('malformed-response', 'malformed response, nothing executed'); break; }
        const { move, conf, goalP } = ok;
        if (conf < GATE) { stop('below-gate-human-review', `${move} c=${conf.toFixed(2)} < ${GATE} -> stopped for human review`); break; }
        if (move === 'done') { stop(goalP >= GATE ? 'goal-reached' : 'done-but-goal-unconfirmed', `done c=${conf.toFixed(2)} goalP=${goalP.toFixed(2)}`); break; }
        if (move === 'stuck') { stop('stuck', `model reports stuck c=${conf.toFixed(2)}`); break; }
        if (last && last.move === move && last.fingerprint === fingerprint) { stop('repeat-no-change', `${move} again on an unchanged page -> stopped`); break; }

        const outcome = await execute(page, elements, move);
        log({ ...row, outcome });
        console.log(`step ${step}: ${move} c=${conf.toFixed(2)} -> ${outcome} (goalP=${goalP.toFixed(2)}, ${call.latencyMs}ms)`);
        if (outcome === 'page-changed' || outcome === 'invalid-move' || outcome === 'no-such-element' || outcome === 'denied') { verdict = outcome; break; }
        stepLog.push({ action: move, outcome });
        totals.steps += 1;
        last = { move, fingerprint };
    }
} catch (err) {
    verdict = `error: ${redact(String(err)).slice(0, 300)}`;
    console.error(verdict);
} finally {
    await page.screenshot({ path: path.join(OUT, 'final.png') }).catch(() => {});
    writeFile('verdict.json', JSON.stringify({ verdict, goal: GOAL, startUrl: safeUrl(START_URL), ...totals, finishedAt: new Date().toISOString() }, null, 2));
    await browser.close();
    for (const f of fs.readdirSync(OUT)) if (f.endsWith('.png')) fs.chmodSync(path.join(OUT, f), 0o600);
    console.log(`\nVERDICT ${verdict}  steps=${totals.steps} jevCalls=${totals.jevCalls} tokens=${totals.inputTokens} avgJevMs=${Math.round(totals.jevMs / Math.max(totals.jevCalls, 1))}`);
    console.log('Screenshots can show typed values. Keep the output directory private.');
}
