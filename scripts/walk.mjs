/**
 * Full product walk: a cheap decision model drives, a vision model only looks.
 * Requires: npm i -D @playwright/test && npx playwright install chromium
 *
 * For each goal in the spec, the driver moves the browser one whole move at a time until a
 * deterministic check (`reached`, a regex on the page title) passes. On arrival the page is
 * screenshotted once and DeepSeek vision reviews it for defects a text state cannot show:
 * overlap, clipping, invisible text, raw keys, broken layout.
 *
 *   node scripts/walk.mjs --spec examples/walk.json                  # Jev drives, DeepSeek reviews
 *   node scripts/walk.mjs --spec examples/walk.json --driver vision  # baseline: DeepSeek vision drives too
 *   node scripts/walk.mjs --spec examples/walk.json --watch          # headed, HUD, walk.webm
 *   [--out walk-run] [--gate 0.8] [--max-steps 8] [--no-review] [--watch]
 *
 * Running both drivers on the same spec is how the saving is measured, not assumed.
 *
 * Keys: TYPESAFE_API_KEY as in jev.mjs. DEEPSEEK_API_KEY from the environment or DEEPSEEK_ENV_FILE
 * (default ~/.config/deepseek/env). Neither is ever printed.
 *
 * SAFETY. Scratch or staging instances and throwaway credentials only. Values quoted in a goal stay
 * local (the models see <v0>, <v1>). Screenshots DO go to the vision API, so never walk pages that
 * show real customer data. With --watch, the video shows whatever is typed into non-password fields,
 * so use throwaway credentials only. Output directory is 0700, files 0600.
 */
import { chromium } from '@playwright/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { jev } from './jev.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true]);
    return acc;
}, []));
const fail = (msg) => { console.error(msg); process.exit(2); };
if (typeof args.spec !== 'string') fail('usage: node walk.mjs --spec walk.json [--driver jev|vision] [--out dir] [--gate 0..1] [--max-steps n] [--no-review] [--watch]');
const DRIVER = args.driver ?? 'jev';
if (!['jev', 'vision'].includes(DRIVER)) fail('--driver must be jev or vision');
const GATE = Number(args.gate ?? 0.8);
const MAX_STEPS = Number(args['max-steps'] ?? 8);
if (!Number.isFinite(GATE) || GATE < 0 || GATE > 1) fail('--gate must be between 0 and 1');
if (!Number.isInteger(MAX_STEPS) || MAX_STEPS < 1) fail('--max-steps must be a positive integer');
const REVIEW = !args['no-review'];
const WATCH = args.watch === true;
const OUT = path.resolve(typeof args.out === 'string' ? args.out : 'walk-run');

const spec = JSON.parse(fs.readFileSync(args.spec, 'utf8'));
if (!Array.isArray(spec.goals) || !spec.goals.length) fail('spec needs a non-empty "goals" array');
for (const g of spec.goals) if (!g.id || !g.goal || !g.reached) fail('every goal needs "id", "goal" and "reached" (a regex on the page title)');
const START = /^[a-z]+:\/\//i.test(spec.start) ? spec.start : pathToFileURL(path.resolve(spec.start)).href;

// Per 1M tokens, USD. Jev: input only. DeepSeek deepseek-flash, cache miss, [off-peak, peak], read 2026-09-19.
const PRICE = { jevIn: 0.042, dsIn: [0.15, 0.3], dsOut: [0.6, 1.2] };

const SELECTOR = 'a, button, input, select, textarea, [role="button"], [role="tab"], [role="menuitem"]';
const FILL_TYPES = new Set(['text', 'email', 'password', 'search', 'tel', 'url', 'number']);
const CLICK_INPUT_TYPES = new Set(['submit', 'button', 'checkbox', 'radio', 'image']);
const DENY_CLICK = [
    /\b(delete|remove|destroy|erase|sign ?out|log ?out|pay now|purchase|buy now|place order|confirm order|cancel subscription|deactivate)\b/i,
    /حذف|إزالة|ازالة|تسجيل الخروج|ادفع|الدفع الآن|شراء|تأكيد الطلب|إلغاء الاشتراك/,
];

// Secret values stay local: every quoted literal or email in any goal becomes <vN> everywhere.
const CANDIDATES = [];
const SECRET_RE = /'([^']+)'|"([^"]+)"|([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const maskGoal = (text) => text.replace(SECRET_RE, (whole, a, b, c) => {
    const v = (a ?? b ?? c ?? '').trim();
    if (!v) return whole;
    let i = CANDIDATES.indexOf(v);
    if (i === -1 && CANDIDATES.length < 6) i = CANDIDATES.push(v) - 1;
    return i === -1 ? whole : `<v${i}>`;
});
const goals = spec.goals.map((g) => ({ ...g, masked: maskGoal(g.goal), reachedRe: new RegExp(g.reached, 'i') }));
const redact = (s) => CANDIDATES.reduce((t, v, i) => t.split(v).join(`<v${i}>`), String(s ?? ''));
const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'file:' ? `file:${path.basename(x.pathname)}` : x.origin + x.pathname; } catch { return '(unparseable url)'; } };

function installHud() {
    if (window.top !== window) return;
    const rootSelector = '[data-jevaluate-hud]';
    const build = () => {
        let root = document.querySelector(rootSelector);
        if (root) return root;
        root = document.createElement('section');
        root.setAttribute('data-jevaluate-hud', '');
        root.style.cssText = 'position:fixed;right:20px;bottom:20px;width:360px;box-sizing:border-box;padding:14px;background:#e9e7e1;color:#0b0b0b;border:3px solid #0b0b0b;border-radius:0;box-shadow:none;z-index:2147483647;pointer-events:none;font:700 12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-transform:uppercase;';
        root.innerHTML = `
            <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;border-bottom:3px solid #0b0b0b;padding-bottom:8px;margin-bottom:10px">
                <div style="font-size:22px;letter-spacing:-1px">JEVALUATE</div>
                <div data-hud="driver" style="color:#ff4f00;text-align:right"></div>
            </div>
            <div data-hud="goal-count" style="margin-bottom:4px"></div>
            <div data-hud="goal" style="font-weight:500;text-transform:none;overflow-wrap:anywhere;margin-bottom:10px"></div>
            <div style="font-size:10px;margin-bottom:2px">MOVE</div>
            <div data-hud="move" style="overflow-wrap:anywhere;margin-bottom:10px"></div>
            <div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:4px"><span>CONFIDENCE</span><span data-hud="confidence"></span></div>
            <div style="position:relative;height:14px;border:2px solid #0b0b0b;margin-bottom:10px;box-sizing:border-box">
                <div data-hud="bar" style="height:100%;width:0;background:#ff4f00"></div>
                <div data-hud="gate" style="position:absolute;top:-5px;bottom:-5px;width:3px;background:#0b0b0b"></div>
            </div>
            <div data-hud="state" style="color:#ff4f00;font-size:25px;line-height:1;margin-bottom:5px"></div>
            <div data-hud="reason" style="font-weight:500;text-transform:none;overflow-wrap:anywhere"></div>`;
        (document.body || document.documentElement).appendChild(root);
        return root;
    };
    window.__jevaluateHudRender = (state) => {
        const root = build();
        const set = (name, value) => { root.querySelector(`[data-hud="${name}"]`).textContent = value; };
        set('driver', state.driver);
        set('goal-count', `GOAL ${state.goalNumber} OF ${state.goalTotal}`);
        set('goal', state.goal);
        set('move', state.move);
        set('confidence', Number(state.confidence).toFixed(2));
        set('state', state.state);
        set('reason', state.reason);
        root.querySelector('[data-hud="bar"]').style.width = `${Math.max(0, Math.min(1, Number(state.confidence))) * 100}%`;
        root.querySelector('[data-hud="gate"]').style.left = `calc(${Math.max(0, Math.min(1, Number(state.gate))) * 100}% - 1px)`;
        root.style.display = 'block';
    };
}

let hudState = {
    driver: DRIVER === 'jev' ? 'JEV' : 'DEEPSEEK VISION', goalNumber: 0, goalTotal: 0,
    goal: '', move: 'WAITING FOR MOVE', confidence: 0, gate: GATE, state: 'THINKING', reason: '',
};

async function updateHud(page, patch) {
    if (!WATCH) return;
    const cleanPatch = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value]));
    hudState = { ...hudState, ...cleanPatch };
    const render = () => page.evaluate((state) => {
        if (typeof window.__jevaluateHudRender !== 'function') return false;
        window.__jevaluateHudRender(state);
        return true;
    }, hudState).catch(() => false);
    if (!(await render())) {
        await page.evaluate(installHud).catch(() => {});
        await render();
    }
}

async function screenshotWithoutHud(page, options) {
    if (!WATCH) return page.screenshot(options);
    const previousDisplay = await page.evaluate(() => {
        const root = document.querySelector('[data-jevaluate-hud]');
        if (!root) return null;
        const display = root.style.display;
        root.style.display = 'none';
        return display;
    }).catch(() => null);
    try {
        return await page.screenshot(options);
    } finally {
        await page.evaluate((display) => {
            const root = document.querySelector('[data-jevaluate-hud]');
            if (root) root.style.display = display ?? 'block';
        }, previousDisplay).catch(() => {});
    }
}

const kindOf = (e) => (e.tag === 'textarea' || (e.tag === 'input' && FILL_TYPES.has(e.type)) ? 'fill'
    : e.tag === 'select' ? 'none'
        : e.tag === 'input' && !CLICK_INPUT_TYPES.has(e.type) ? 'none' : 'click');
const describe = (e) => `${e.tag}${e.type ? ` type=${e.type}` : ''}${e.name ? ` name=${e.name}` : ''} "${e.label}"${e.current ? ` current_value="${e.current}"` : ' (empty)'}`;

const readElement = (handle) => handle.evaluate((e) => {
    const tag = e.tagName.toLowerCase();
    const label = e.getAttribute('aria-label') ?? e.getAttribute('placeholder') ?? e.labels?.[0]?.textContent?.trim() ?? (e.textContent || e.value) ?? '';
    const isField = tag === 'input' || tag === 'textarea';
    return {
        tag,
        type: tag === 'input' ? (e.getAttribute('type') ?? 'text').toLowerCase() : null,
        name: e.getAttribute('name') ?? '',
        label: String(label).trim().replace(/\s+/g, ' ').slice(0, 60),
        current: !isField || ['submit', 'button'].includes(e.type) ? '' : e.type === 'password' ? (e.value ? '(filled)' : '') : String(e.value ?? '').trim().slice(0, 40),
    };
});

async function captureState(page, goal, stepLog) {
    await page.waitForTimeout(400);
    const elements = [];
    for (const handle of (await page.locator(SELECTOR).elementHandles()).slice(0, 60)) {
        if (elements.length >= 25) break;
        if (WATCH && await handle.evaluate((e) => Boolean(e.closest('[data-jevaluate-hud]'))).catch(() => false)) continue;
        if (!(await handle.isVisible().catch(() => false))) continue;
        const info = await readElement(handle).catch(() => null);
        if (info) elements.push({ idx: elements.length + 1, handle, ...info, label: redact(info.label), current: redact(info.current) });
    }
    const lines = elements.map((e) => `[${e.idx}] ${describe(e)}`);
    const criteria = {};
    for (const e of elements) {
        if (kindOf(e) === 'fill') CANDIDATES.forEach((_, i) => { criteria[`fill_${e.idx}_v${i}`] = `Type the value <v${i}> into element [${e.idx}] ${describe(e)}`; });
        if (kindOf(e) === 'click') criteria[`click_${e.idx}`] = `Click element [${e.idx}] ${describe(e)}`;
    }
    criteria.stuck = 'No listed move makes progress toward the goal.';
    const stateText = [
        `Goal: ${goal.masked}`,
        `Typeable values allowed for fill: ${CANDIDATES.map((_, i) => `<v${i}>`).join(', ') || 'none'}. They are placeholders for real values the goal refers to.`,
        `URL: ${safeUrl(page.url())}`,
        `Page title: ${redact(await page.title().catch(() => ''))}`,
        'Interactive elements:',
        ...lines,
        stepLog.length ? `Steps taken so far for this goal: ${stepLog.join('; ')}` : 'No steps taken yet for this goal.',
    ].join('\n');
    return { stateText, elements, criteria, fingerprint: `${safeUrl(page.url())}\n${redact(await page.title().catch(() => ''))}\n${lines.join('\n')}` };
}

const MOVE_INSTRUCTIONS = 'You drive a browser one step at a time toward the goal in the state. Pick the single best next move. Each option is one complete move; prefer a move whose target field is empty or needs its stated value. Typing into a field that already holds that exact value is wasted. Do not repeat a step that was already taken unless the page changed.';

let dsKey;
function deepseekKey() {
    if (dsKey) return dsKey;
    if (process.env.DEEPSEEK_API_KEY) return (dsKey = process.env.DEEPSEEK_API_KEY);
    const file = process.env.DEEPSEEK_ENV_FILE ?? path.join(os.homedir(), '.config/deepseek/env');
    const line = fs.existsSync(file) && fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim().replace(/^export /, '')).find((l) => l.startsWith('DEEPSEEK_API_KEY='));
    if (!line) throw new Error(`DEEPSEEK_API_KEY not found in environment or ${file}`);
    return (dsKey = line.slice('DEEPSEEK_API_KEY='.length).replace(/^['"]|['"]$/g, ''));
}

/** One DeepSeek vision call that must answer in JSON. Returns { json, usage, latencyMs }. */
async function deepseekVision(prompt, png, { maxTokens = 900 } = {}) {
    const t0 = Date.now();
    const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${deepseekKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'deepseek-flash', max_tokens: maxTokens, response_format: { type: 'json_object' },
            messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] }],
        }),
        signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    let json = null;
    try { json = JSON.parse(data.choices?.[0]?.message?.content ?? ''); } catch { /* validated by the caller */ }
    return { json, usage: data.usage ?? {}, latencyMs: Date.now() - t0 };
}

const totals = { jev: { calls: 0, in: 0, ms: 0 }, dsDrive: { calls: 0, in: 0, out: 0, ms: 0 }, dsReview: { calls: 0, in: 0, out: 0, ms: 0 } };
const addDs = (bucket, r) => { bucket.calls += 1; bucket.in += r.usage.prompt_tokens ?? 0; bucket.out += r.usage.completion_tokens ?? 0; bucket.ms += r.latencyMs; };

/** Returns { move, conf } or null. Nothing is executed unless the move is one we offered. */
async function decide(page, state) {
    if (DRIVER === 'jev') {
        const call = await jev(state.stateText, { move: { type: 'choice', instructions: MOVE_INSTRUCTIONS, criteria: state.criteria } });
        totals.jev.calls += 1; totals.jev.in += call.usage?.input_tokens ?? 0; totals.jev.ms += call.latencyMs;
        const a = call.answers?.move;
        return typeof a?.choice === 'string' && Object.hasOwn(state.criteria, a.choice) && Number.isFinite(a.confidence) ? { move: a.choice, conf: a.confidence } : null;
    }
    const prompt = `${MOVE_INSTRUCTIONS}\n\n${state.stateText}\n\nOptions:\n${Object.entries(state.criteria).map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nThe screenshot shows the same page. Reply as JSON: {"move": "<one option id>", "confidence": <0 to 1>}`;
    const r = await deepseekVision(prompt, await screenshotWithoutHud(page), { maxTokens: 1200 });
    addDs(totals.dsDrive, r);
    const conf = Number(r.json?.confidence);
    return typeof r.json?.move === 'string' && Object.hasOwn(state.criteria, r.json.move) && Number.isFinite(conf) ? { move: r.json.move, conf } : null;
}

const describeMove = (move, elements) => {
    const fill = move.match(/^fill_(\d+)_v(\d+)$/);
    const click = move.match(/^click_(\d+)$/);
    const el = elements.find((e) => e.idx === Number((fill ?? click)?.[1]));
    if (fill) return `TYPE <v${fill[2]}> INTO [${fill[1]}] "${el?.label ?? 'unknown'}"`;
    if (click) return `CLICK [${click[1]}] "${el?.label ?? 'unknown'}"`;
    return move === 'stuck' ? 'STOP' : redact(move).toUpperCase();
};

async function outlineTarget(page, handle) {
    if (!WATCH) return;
    const previous = await handle.evaluate((e) => ({ outline: e.style.outline, outlineOffset: e.style.outlineOffset }));
    await handle.evaluate((e) => { e.style.outline = '4px solid #ff4f00'; e.style.outlineOffset = '2px'; });
    await page.waitForTimeout(600);
    await handle.evaluate((e, styles) => { e.style.outline = styles.outline; e.style.outlineOffset = styles.outlineOffset; }, previous).catch(() => {});
}

async function execute(page, elements, move) {
    const fill = move.match(/^fill_(\d+)_v(\d+)$/);
    const click = move.match(/^click_(\d+)$/);
    const el = elements.find((e) => e.idx === Number((fill ?? click)?.[1]));
    if (!el) return 'no-such-element';
    const now = await readElement(el.handle).catch(() => null);
    if (!now || now.tag !== el.tag || now.type !== el.type || now.name !== el.name || redact(now.label) !== el.label) return 'page-changed';
    if (fill) {
        const value = CANDIDATES[Number(fill[2])];
        if (value === undefined || kindOf(el) !== 'fill') return 'invalid-move';
        await outlineTarget(page, el.handle);
        await el.handle.fill(value);
        return `filled <v${fill[2]}> into [${el.idx}]`;
    }
    if (kindOf(el) !== 'click') return 'invalid-move';
    if (DENY_CLICK.some((re) => re.test(el.label))) return 'denied';
    await outlineTarget(page, el.handle);
    await el.handle.click();
    await page.waitForTimeout(700);
    return `clicked [${el.idx}] "${el.label}"`;
}

const REVIEW_PROMPT = (goal) => `You are a meticulous QA reviewer looking at ONE screenshot of ${spec.product ?? 'a web application'}. The tester just completed: "${goal.masked}".
Report only defects you can SEE in the pixels: overlapping or clipped elements, text that is unreadable or nearly invisible against its background, raw translation keys or code-like strings shown as copy (for example words.joined.by.dots), broken or empty layout, misaligned controls, wrong-language text. Do not invent problems, do not comment on taste, and do not report anything you cannot point to.
Reply as JSON: {"verdict": "clean" | "defects", "findings": [{"severity": "high" | "medium" | "low", "where": "<which part of the screen>", "issue": "<what is wrong, one sentence>"}]}`;

fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), data, { mode: 0o600 });
write('trace.jsonl', '');
const log = (row) => fs.appendFileSync(path.join(OUT, 'trace.jsonl'), JSON.stringify(row) + '\n');

const VIDEO_DIR = path.join(OUT, 'video');
const browser = WATCH ? await chromium.launch({ headless: false, slowMo: 250 }) : await chromium.launch();
const context = WATCH
    ? await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: VIDEO_DIR, size: { width: 1280, height: 800 } } })
    : await browser.newContext({ viewport: { width: 1280, height: 800 } });
if (WATCH) await context.addInitScript(installHud);
const page = await context.newPage();
const video = WATCH ? page.video() : null;
let videoOutput = null;
const results = [];
const wallStart = Date.now();
try {
    await page.goto(START, { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (const [goalIndex, goal] of goals.entries()) {
        const r = { id: goal.id, goal: goal.masked, status: 'incomplete', steps: 0, review: null };
        results.push(r);
        const stepLog = [];
        let last = null;
        await updateHud(page, { goalNumber: goalIndex + 1, goalTotal: goals.length, goal: goal.masked, move: 'WAITING FOR MOVE', confidence: 0, state: 'THINKING', reason: '' });
        for (let step = 1; step <= MAX_STEPS + 1; step++) {
            if (goal.reachedRe.test(await page.title().catch(() => ''))) {
                r.status = 'reached';
                await updateHud(page, { state: 'REACHED', reason: '' });
                break;
            }
            if (step > MAX_STEPS) {
                r.status = 'max-steps';
                await updateHud(page, { state: 'STOPPED', reason: 'Maximum steps reached.' });
                break;
            }
            const state = await captureState(page, goal, stepLog);
            await updateHud(page, { state: 'THINKING', reason: '', move: 'WAITING FOR MOVE' });
            const d = await decide(page, state);
            if (!d) {
                r.status = 'malformed-response';
                await updateHud(page, { state: 'STOPPED', reason: 'Malformed model response.' });
                break;
            }
            const moveText = describeMove(d.move, state.elements);
            if (d.conf < GATE) {
                r.status = `below-gate (${d.move} c=${d.conf.toFixed(2)})`;
                await updateHud(page, { move: moveText, confidence: d.conf, state: 'STOPPED', reason: `Confidence ${d.conf.toFixed(2)} is below gate ${GATE.toFixed(2)}.` });
                break;
            }
            if (d.move === 'stuck') {
                r.status = 'stuck';
                await updateHud(page, { move: moveText, confidence: d.conf, state: 'STOPPED', reason: 'The driver found no move that makes progress.' });
                break;
            }
            if (last && last.move === d.move && last.fingerprint === state.fingerprint) {
                r.status = 'repeat-no-change';
                await updateHud(page, { move: moveText, confidence: d.conf, state: 'STOPPED', reason: 'The same move repeated without a page change.' });
                break;
            }
            await updateHud(page, { move: moveText, confidence: d.conf, state: 'ACTING', reason: '' });
            const outcome = await execute(page, state.elements, d.move);
            log({ goal: goal.id, step, driver: DRIVER, move: d.move, confidence: d.conf, outcome, state: state.stateText });
            console.log(`${goal.id} step ${step}: ${d.move} c=${d.conf.toFixed(2)} -> ${outcome}`);
            if (['page-changed', 'invalid-move', 'no-such-element', 'denied'].includes(outcome)) {
                r.status = outcome;
                await updateHud(page, { state: 'STOPPED', reason: `Move stopped: ${outcome}.` });
                break;
            }
            stepLog.push(`${d.move} -> ${outcome}`); r.steps += 1; last = { move: d.move, fingerprint: state.fingerprint };
        }
        const shot = await screenshotWithoutHud(page, { fullPage: true });
        write(`${goal.id}.png`, shot);
        if (REVIEW && r.status === 'reached') {
            await updateHud(page, { state: 'REVIEWING', reason: 'Visual review in progress.' });
            const v = await deepseekVision(REVIEW_PROMPT(goal), shot);
            addDs(totals.dsReview, v);
            r.review = v.json && Array.isArray(v.json.findings) ? v.json : { verdict: 'unparseable', findings: [] };
            console.log(`${goal.id} review: ${r.review.verdict}, ${r.review.findings.length} finding(s)`);
            await updateHud(page, { state: 'REACHED', reason: '' });
        } else console.log(`${goal.id}: ${r.status}`);
        if (r.status !== 'reached') break; // later goals depend on earlier ones
    }
} catch (err) {
    results.push({ id: 'error', status: redact(String(err)).slice(0, 300) });
    await updateHud(page, { state: 'STOPPED', reason: redact(String(err)).slice(0, 160) });
    console.error(redact(String(err)).slice(0, 300));
} finally {
    if (WATCH) {
        await page.waitForTimeout(3500).catch(() => {}); // hold the last frame so the recording ends on the final state
        await context.close();
        if (video) {
            const recorded = await video.path();
            videoOutput = path.join(OUT, 'walk.webm');
            fs.renameSync(recorded, videoOutput);
            fs.chmodSync(videoOutput, 0o600);
        }
        await browser.close();
    } else await browser.close();
}

const usd = (n) => `$${n.toFixed(5)}`;
const dsCost = (b, i) => (b.in * PRICE.dsIn[i] + b.out * PRICE.dsOut[i]) / 1e6;
const cost = {
    jev: totals.jev.in * PRICE.jevIn / 1e6,
    driveOffPeak: dsCost(totals.dsDrive, 0), drivePeak: dsCost(totals.dsDrive, 1),
    reviewOffPeak: dsCost(totals.dsReview, 0), reviewPeak: dsCost(totals.dsReview, 1),
};
const drivingCalls = totals.jev.calls + totals.dsDrive.calls;
const summary = {
    driver: DRIVER, gate: GATE, finishedAt: new Date().toISOString(), wallSeconds: Math.round((Date.now() - wallStart) / 1000),
    goalsReached: results.filter((r) => r.status === 'reached').length, goals: goals.length,
    drivingCalls, drivingTokens: totals.jev.in + totals.dsDrive.in + totals.dsDrive.out,
    drivingAvgMs: Math.round((totals.jev.ms + totals.dsDrive.ms) / Math.max(drivingCalls, 1)),
    drivingCostOffPeak: cost.jev + cost.driveOffPeak, drivingCostPeak: cost.jev + cost.drivePeak,
    reviewCalls: totals.dsReview.calls, reviewTokens: totals.dsReview.in + totals.dsReview.out, reviewCostOffPeak: cost.reviewOffPeak, reviewCostPeak: cost.reviewPeak,
    ...(WATCH ? { video: 'walk.webm' } : {}),
    totals, results,
};
write('summary.json', JSON.stringify(summary, null, 1));

const findings = results.flatMap((r) => (r.review?.findings ?? []).map((f) => ({ page: r.id, ...f })));
write('walk-report.md', [
    `# Walk report`, '',
    `- Driver: ${DRIVER === 'jev' ? 'Jev (text state, whole moves)' : 'DeepSeek vision (screenshot at every step)'}, gate ${GATE}`,
    `- Goals reached: ${summary.goalsReached} of ${summary.goals} in ${summary.wallSeconds} s`,
    `- Driving: ${drivingCalls} calls, ${summary.drivingTokens} tokens, ${summary.drivingAvgMs} ms average, ${usd(summary.drivingCostOffPeak)} off-peak / ${usd(summary.drivingCostPeak)} peak`,
    `- Visual review: ${summary.reviewCalls} calls, ${summary.reviewTokens} tokens, ${usd(cost.reviewOffPeak)} off-peak / ${usd(cost.reviewPeak)} peak`, '',
    '## Goals', '', '| Goal | Status | Moves | Review |', '|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.status} | ${r.steps ?? ''} | ${r.review ? `${r.review.verdict} (${r.review.findings.length})` : 'not reviewed'} |`), '',
    '## Findings', '',
    ...(findings.length ? ['| Page | Severity | Where | Issue |', '|---|---|---|---|', ...findings.map((f) => `| ${f.page} | ${f.severity} | ${redact(f.where)} | ${redact(f.issue)} |`)] : ['None reported.']), '',
    'A vision model can miss defects and can invent them. Treat every finding as a lead to confirm on the screenshot beside this file.', '',
].join('\n'));

if (videoOutput) console.log(`Video: ${videoOutput}`);
console.log(`\nWALK ${summary.goalsReached}/${summary.goals} goals  driver=${DRIVER}  driving: ${drivingCalls} calls ${summary.drivingTokens} tok ${summary.drivingAvgMs}ms avg ${usd(summary.drivingCostOffPeak)}  review: ${summary.reviewCalls} calls ${usd(cost.reviewOffPeak)}  findings ${findings.length}`);
console.log(`Report: ${path.join(OUT, 'walk-report.md')}. Screenshots can show typed values; keep the directory private.`);
