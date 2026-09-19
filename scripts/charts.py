"""Redraw the README charts. Needs matplotlib:  pip install matplotlib

    python3 scripts/charts.py            # reads data/, writes assets/

The calibration and coverage charts are drawn from data/routing-eval-rows.json (60 synthetic phrases,
raw model answers). The browser-loop and tree-test charts use the summary figures recorded below,
because their raw traces contain page text from a private application. The walk chart is drawn from
data/walk-demo/, two measured runs of scripts/walk.mjs on examples/demo-app.

Style: brutalist. Black, concrete, one signal orange, heavy rules, monospace, uppercase titles.
"""
import json, sys, random
from pathlib import Path
import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
ROOT = Path(__file__).resolve().parent.parent
OUT = sys.argv[1] if len(sys.argv) > 1 else str(ROOT / 'assets')
Path(OUT).mkdir(parents=True, exist_ok=True)
SURF, INK, INK2, MUTED, GRID = '#e9e7e1', '#0b0b0b', '#0b0b0b', '#0b0b0b', '#0b0b0b'
BLUE, ORANGE = '#0b0b0b', '#ff4f00'  # BLUE is kept as a name; the first series is black now
plt.rcParams.update({'font.family': ['Menlo', 'DejaVu Sans Mono', 'monospace'], 'font.size': 10.5, 'patch.edgecolor': INK, 'patch.linewidth': 1.8, 'patch.force_edgecolor': True,
    'grid.linestyle': (0, (1, 3)), 'axes.linewidth': 2.6, 'axes.edgecolor': GRID, 'axes.labelcolor': INK2,
    'xtick.color': MUTED, 'ytick.color': MUTED, 'figure.facecolor': SURF, 'axes.facecolor': SURF, 'savefig.facecolor': SURF})
def frame(ax, title, sub):
    for s in ax.spines.values(): s.set_visible(True); s.set_color(INK); s.set_linewidth(2.6)
    ax.tick_params(length=5, width=2, color=INK)
    ax.set_title(title.upper(), loc='left', color=INK, fontsize=14, fontweight='heavy', pad=30, fontfamily=['Arial Black', 'Helvetica Neue', 'DejaVu Sans'])
    ax.text(0, 1.04, sub, transform=ax.transAxes, color=INK, fontsize=9.5, va='bottom')
def save(fig, name): fig.savefig(f'{OUT}/{name}.png', dpi=200, bbox_inches='tight', pad_inches=0.3); plt.close(fig)

# 1. calibration strip
rows = json.load(open(ROOT / 'data' / 'routing-eval-rows.json'))
random.seed(7)
slices = ['en', 'msa', 'dialect', 'mixed']; names = ['English', 'Standard Arabic', 'Arabic dialect', 'Mixed script']
fig, ax = plt.subplots(figsize=(9, 4.6))
ax.axvspan(0.8, 1.02, color='#cde2fb', alpha=0.35, lw=0)
ax.axvline(0.8, color=INK2, lw=1, ls=(0, (4, 3)))
ax.text(0.815, 3.62, 'gate 0.8: act', color=INK2, fontsize=10, va='center')
ax.text(0.785, 3.62, 'fall through', color=INK2, fontsize=10, va='center', ha='right')
for ok, c, mk, lab in ((True, BLUE, 'o', 'correct'), (False, ORANGE, 'X', 'wrong')):
    xs, ys = [], []
    for r in rows:
        if (r['operation']['ok'] and r['resource']['ok']) != ok: continue
        xs.append(min(r['operation']['confidence'], r['resource']['confidence']))
        ys.append(3 - slices.index(r['slice']) + random.uniform(-0.22, 0.22))
    ax.scatter(xs, ys, s=70 if ok else 95, c=c, marker=mk, edgecolors=SURF, linewidths=1.2, label=lab, zorder=3, alpha=0.95)
ax.set_yticks([3, 2, 1, 0]); ax.set_yticklabels(names, color=INK); ax.set_ylim(-0.6, 3.9); ax.set_xlim(0, 1.02)
ax.set_xlabel('min(confidence) across the two questions'); ax.grid(axis='x', color=GRID, lw=0.8); ax.set_axisbelow(True)
ax.legend(loc='lower left', frameon=False, ncol=2, labelcolor=INK2, bbox_to_anchor=(0, -0.3))
frame(ax, 'Every wrong answer fell below the gate', '60 synthetic routing phrases, jev-1.13.0, two choice questions each. 10 wrong, highest wrong confidence 0.72.')
save(fig, 'calibration')

# 2. coverage by slice at the gate
cov = []
for s in slices:
    rs = [r for r in rows if r['slice'] == s]
    cov.append(100 * sum(min(r['operation']['confidence'], r['resource']['confidence']) >= 0.8 for r in rs) / len(rs))
fig, ax = plt.subplots(figsize=(9, 3.6))
b = ax.barh(names[::-1], cov[::-1], height=0.5, color=BLUE)
for rect, v in zip(b, cov[::-1]): ax.text(v + 1.5, rect.get_y() + rect.get_height() / 2, f'{v:.0f}%', va='center', color=INK, fontsize=11)
ax.set_xlim(0, 100); ax.set_xlabel('share of phrases answered above the gate (accuracy inside that share: 100% in every slice)')
ax.grid(axis='x', color=GRID, lw=0.8); ax.set_axisbelow(True); ax.tick_params(axis='y', labelcolor=INK)
frame(ax, 'Dialect costs coverage, not correctness', 'Coverage at gate 0.8 by input language. Below the gate the system does what it did before.')
save(fig, 'coverage-by-language')

# 3. browser loop confidence per step
steps = ['1  type email', '2  type password', '3  click sign in', '4  click CRM icon', '5  click CRM icon again']
conf = [1.00, 1.00, 1.00, 0.88, 0.46]
fig, ax = plt.subplots(figsize=(9, 3.8))
b = ax.barh(steps[::-1], conf[::-1], height=0.5, color=[ORANGE if c < 0.8 else BLUE for c in conf[::-1]])
for rect, v in zip(b, conf[::-1]): ax.text(v + 0.015, rect.get_y() + rect.get_height() / 2, f'{v:.2f}' + ('  stopped' if v < 0.8 else ''), va='center', color=INK, fontsize=11)
ax.axvline(0.8, color=INK2, lw=1, ls=(0, (4, 3))); ax.text(0.81, 4.55, 'gate 0.8', color=INK2, fontsize=10, ha='left')
ax.set_xlim(0, 1.3); ax.set_xticks([0, 0.2, 0.4, 0.6, 0.8, 1.0]); ax.set_xlabel('confidence of the chosen move'); ax.set_ylim(-0.6, 4.8)
ax.grid(axis='x', color=GRID, lw=0.8); ax.set_axisbelow(True); ax.tick_params(axis='y', labelcolor=INK)
frame(ax, 'The loop logged in unaided, then stopped for a human', 'Arabic-rendered login page. 5 calls, 7,691 input tokens, 513 ms average, about USD 0.0003 for the run.')
save(fig, 'browser-loop')

# 4. tree test
trees = ['Object-named folders\n(13 icons)', "Today's desktop\n(21 icons)", 'Eight short job labels\n(10 icons)']
en, ar = [92.7, 65.5, 58.2], [90.9, 52.7, 61.8]
fig, ax = plt.subplots(figsize=(9, 4.2)); h = 0.34
for i, (e, a) in enumerate(zip(en, ar)):
    y = 2 - i
    ax.barh(y + h / 2 + 0.02, e, height=h, color=BLUE, label='English' if i == 0 else None)
    ax.barh(y - h / 2 - 0.02, a, height=h, color=ORANGE, label='Arabic' if i == 0 else None)
    ax.text(e + 1.2, y + h / 2 + 0.02, f'{e:.1f}%', va='center', color=INK); ax.text(a + 1.2, y - h / 2 - 0.02, f'{a:.1f}%', va='center', color=INK)
ax.set_yticks([2, 1, 0]); ax.set_yticklabels(trees, color=INK); ax.set_xlim(0, 108); ax.set_xticks([0, 25, 50, 75, 100])
ax.set_xlabel('correct first click (55 tasks per language, 110 calls per tree, about 3 points of run-to-run noise)')
ax.grid(axis='x', color=GRID, lw=0.8); ax.set_axisbelow(True)
ax.legend(loc='lower right', frameon=False, labelcolor=INK2)
frame(ax, 'Folder names decided by a first-click test, not by taste', 'A newcomer proxy picks which icon to open for each task sentence. Fewer, broader labels lost to object names.')
save(fig, 'tree-test')

# 5. walk: who drives
walk = {d: json.load(open(ROOT / 'data' / 'walk-demo' / f'{d}-summary.json')) for d in ('jev', 'vision')}
labels = ['DeepSeek vision drives\n(screenshot every move)', 'Jev drives\n(text state, whole moves)']
panels = [('driving cost per walk, USD (off-peak)', [walk['vision']['drivingCostOffPeak'], walk['jev']['drivingCostOffPeak']], '${:.5f}'),
          ('average latency per move, ms', [walk['vision']['drivingAvgMs'], walk['jev']['drivingAvgMs']], '{:.0f} ms'),
          ('driving tokens per walk', [walk['vision']['drivingTokens'], walk['jev']['drivingTokens']], '{:,.0f}')]
fig, axes = plt.subplots(1, 3, figsize=(13, 3.6), sharey=True)
for ax, (xlabel, vals, fmt) in zip(axes, panels):
    b = ax.barh(labels, vals, height=0.5, color=[BLUE, ORANGE])
    for rect, v in zip(b, vals): ax.text(v + max(vals) * 0.03, rect.get_y() + rect.get_height() / 2, fmt.format(v), va='center', color=INK, fontweight='bold')
    ax.set_xlim(0, max(vals) * 1.45); ax.set_xlabel(xlabel); ax.set_xticks([]); ax.tick_params(axis='y', labelcolor=INK)
    for s in ax.spines.values(): s.set_color(INK); s.set_linewidth(2.6)
moves = walk['jev']['drivingCalls']
frame(axes[0], 'Same walk, same 5 of 5 goals, same 3 defects found', f"One run each on examples/demo-app: {moves} moves, then one DeepSeek vision review per page in both runs. Review cost is equal; only the driver differs.")
save(fig, 'walk-savings')
