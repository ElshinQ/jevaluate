/**
 * First-click tree test for navigation labels, judged by Jev.
 *
 * For every destination and locale: the task sentence plus the top-level labels go in, Jev picks
 * which label a newcomer would open first. Correct = a label that actually holds the destination.
 *
 *   node tree-test.mjs --tree tree.json --tasks tasks.json [--persona "A staff member at a small company"] [--out results]
 *
 * tree.json:  [{ "id": "sales", "labels": { "en": "Sales", "ar": "المبيعات" }, "holds": ["quotes", "orders"] }, ...]
 * tasks.json: { "quotes": { "en": "Send a customer a price for 20 laptops", "ar": "..." }, ... }
 *             Write tasks in the user's words. Never reuse a word from the label you hope they pick.
 *
 * Labels and synthetic task sentences only; no real data. About 3 points of run-to-run noise:
 * ignore differences under 5 points between trees. A proxy for a newcomer, not a user study.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { jev, pool } from './jev.mjs';

const arg = (name, fallback) => {
    const i = process.argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const v = process.argv[i + 1];
    if (v === undefined || v.startsWith('--')) { console.error(`--${name} needs a value`); process.exit(2); }
    return v;
};
if (!arg('tree') || !arg('tasks')) { console.error('usage: node tree-test.mjs --tree tree.json --tasks tasks.json [--persona "..."] [--gate 0.8] [--out results]'); process.exit(2); }
const GATE = Number(arg('gate', 0.8));
const PERSONA = arg('persona', 'A person is using a software application for the first time.');
const LANG = { en: 'English', ar: 'Arabic', fr: 'French', es: 'Spanish', de: 'German', tr: 'Turkish' };
const tree = JSON.parse(fs.readFileSync(arg('tree'), 'utf8'));
const tasks = JSON.parse(fs.readFileSync(arg('tasks'), 'utf8'));

const placed = new Set(tree.flatMap((n) => n.holds));
const missing = Object.keys(tasks).filter((id) => !placed.has(id));
if (missing.length) throw new Error(`tree does not place: ${missing.join(', ')}`);

if (!Number.isFinite(GATE) || GATE < 0 || GATE > 1) throw new Error('--gate must be between 0 and 1');
const locales = new Set(Object.values(tasks).flatMap((byLocale) => Object.keys(byLocale)));
for (const locale of locales) {
    const bare = tree.filter((n) => typeof n.labels?.[locale] !== 'string' || !n.labels[locale].trim()).map((n) => n.id);
    if (bare.length) throw new Error(`tasks use locale "${locale}" but these tree nodes have no "${locale}" label: ${bare.join(', ')}`);
}

const jobs = Object.entries(tasks).flatMap(([dest, byLocale]) => Object.entries(byLocale).map(([locale, task]) => ({ dest, locale, task })));

const rows = await pool(jobs, async (job) => {
    const criteria = Object.fromEntries(tree.map((n, i) => [`k${i}`, `Open the item labelled "${n.labels[job.locale]}"`]));
    const state = [
        PERSONA,
        `Interface language: ${LANG[job.locale] ?? job.locale}.`,
        `What they want to do: ${job.task}`,
        `The screen shows ${tree.length} items: ${tree.map((n) => `"${n.labels[job.locale]}"`).join(', ')}.`,
    ].join('\n');
    const { answers, usage } = await jev(state, {
        first_click: {
            type: 'choice',
            instructions: 'Which single item would this person open first to do what they want? Judge by the label alone, as a newcomer who has never opened any of them.',
            criteria,
        },
    });
    const a = answers.first_click;
    // A destination may live under more than one label; any of its homes is a correct first click.
    const golds = tree.flatMap((n, i) => (n.holds.includes(job.dest) ? [`k${i}`] : []));
    return {
        ...job, gold: golds.map((g) => tree[Number(g.slice(1))].id).join('+'), pick: tree[Number(a.choice.slice(1))].id,
        ok: golds.includes(a.choice), confidence: a.confidence,
        pGold: golds.reduce((s, g) => s + (a.probabilities[g] ?? 0), 0), tokens: usage?.input_tokens ?? 0,
    };
}, 5);

const good = rows.filter((r) => !r.error);
const pct = (xs, f) => (xs.length ? `${((100 * xs.filter(f).length) / xs.length).toFixed(1)}%` : 'n/a');
console.log(`calls ${good.length}/${rows.length}  tokens ${good.reduce((s, r) => s + r.tokens, 0)}  labels ${tree.length}\n`);
for (const locale of [...new Set(good.map((r) => r.locale))]) {
    const rs = good.filter((r) => r.locale === locale);
    console.log(`${locale}: hit ${pct(rs, (r) => r.ok)}  hit above gate ${pct(rs, (r) => r.ok && r.confidence >= GATE)}  mean p(right label) ${(rs.reduce((s, r) => s + r.pGold, 0) / rs.length).toFixed(3)}`);
}
console.log('\nper label (hits / tasks):');
for (const n of tree) {
    const rs = good.filter((r) => r.gold.split('+').includes(n.id));
    console.log(`  ${n.id.padEnd(24)} ${rs.length ? `${rs.filter((r) => r.ok).length}/${rs.length}` : 'n/a (no task targets it)'}`);
}
console.log('\nlost (read these; most are label problems, a few are decisions for a human):');
for (const r of good.filter((r) => !r.ok)) console.log(`  [${r.locale}] ${r.dest}: wanted ${r.gold}, picked ${r.pick} c=${r.confidence.toFixed(2)} p(right)=${r.pGold.toFixed(2)}`);

const out = arg('out', 'results');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, `${path.basename(arg('tree'), '.json')}-${Date.now()}.json`), JSON.stringify(rows, null, 1));
