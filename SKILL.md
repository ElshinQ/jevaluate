---
name: jevaluate
description: Use when adding fast, cheap, calibrated decisions to software or to a development workflow with TypeSafe Jev (System One model, api.typesafe.ai). Covers intent and tool routing, classification, triage of CI failures and bug findings, pre-checks before an expensive LLM grader, UI text judging, first-click navigation tree tests, and driving a browser step by step. Triggers on "jev", "typesafe", "system one", "calibrated confidence", "confidence gate", "route this message", "classify cheaply", "triage with a model", or any decision that today is a keyword rule or a full LLM call but has a closed set of answers.
---

# TypeSafe Jev: a decision layer, not a writer

Field notes from running `jev-1.13.0` in the build and QA pipeline of a production business application (September 2026). Every number below was measured, not quoted from marketing. Re-measure on your own data before trusting any of them.

## What it is

- One REST endpoint: `POST https://api.typesafe.ai/v1/systemone`, header `Authorization: Bearer $TYPESAFE_API_KEY`.
- Input: a `state` (text or JSON) plus a map of typed `questions`. Output: one typed answer per question, each with probabilities and a calibrated `confidence`.
- Question types: `choice` (pick one option, criteria per option), `score` (ordered levels), `noul` (probability that the answer is yes). There is no free-string answer.
- **It never generates text.** No code, no prose, no commit messages. It cannot see pixels: text in only.
- Measured: about 1.0 s cold including TLS, 200 to 500 ms warm, 400 to 1,700 input tokens per call, output tokens free, USD 0.042 per million input tokens. Roughly USD 0.07 per 1,000 calls.
- SDKs exist (`typesafe_sdk` for Python, `@typesafe-ai/sdk` for JS). Plain `fetch` is enough; `scripts/jev.mjs` is a zero-dependency client.

## When to reach for it

Use Jev when all four hold:

1. The answer space is closed: a list of options, levels, or yes/no.
2. The decision is a judgement over text, not arithmetic, counting or date comparison.
3. You can afford to fall through to today's behaviour when confidence is low.
4. Volume or latency makes a full LLM call wasteful (per message, per log, per UI string, per CI failure).

Do not use it to write anything, to compute anything, to be the final grader of work, or anywhere in a financial or otherwise irreversible critical path.

## The five rules that made it work

1. **Calibration is the product. Gate on it.** In a 60-phrase routing eval (English, Standard Arabic, dialect, mixed script) raw accuracy was 83% on both questions together, but every answer with `min(confidence) >= 0.8` was correct and every wrong answer fell below 0.8. Coverage at the gate was 62%. That is 37 gated answers with no errors: encouraging, not proof. The 95% upper bound on the gated error rate is still about 8%, so measure on your own cases. Design for "act when confident, do today's thing otherwise", never for "always obey".
2. **One complete statement per option.** Asking `action`, `target` and `value` as three separate questions splits the probability mass (0.55 vs 0.42 on the target). One combined choice whose options are whole moves ("Type X into field 3", "Click button 7") calibrated to 1.00. If the options depend on each other, merge them into one question.
3. **Literal criteria, written for a stranger.** Jev answers what you wrote, not what you meant. Every option gets a full descriptive sentence. When a wrong answer makes you say "but I meant...", that sentence is the missing criterion. Two rubric fixes moved our resource accuracy more than any other change.
4. **Small state, filtered in code.** Send only what the question needs. Unrelated detail costs accuracy. Cap lists (we cap at 25 elements, 600 characters per judged line). Include the values that matter: a form state without current field values made the model refill filled fields.
5. **Shadow first, then act.** Ship in `off | shadow | act` modes. Shadow stores the decision beside what really happened for about 7 days. A report command compares them. Only then turn on `act`, and only above the gate.

## Boundaries to copy into every integration

- Jev down, slow, malformed or rate limited means the system behaves exactly as it does today. Set a short timeout (1,200 ms inline). Test 401, 422, 429, 529, timeout and malformed JSON.
- Everything in `state` goes to a third-party API. Send only the single message the user just typed, or interface text any visitor can see, or synthetic QA constants. Never ids, history, records or stored customer data. A user's own message can still contain personal details, so treat that route as personal data and redact or get agreement first.
- Never the final grade. It can front-run an expensive grader; an independent grader still decides.
- Never amounts, ids, dates or filters. It names a category; code and the main model do the rest.
- Pin the versioned model id (`jev-1.13.0`), not `jev-latest`. Aliases move and your thresholds were tuned on one version. Log the `model` field of every response.
- Key in an environment variable or a chmod 600 file outside the repo. Never on a command line, never printed.
- Treat `state` as untrusted: text that argues for its own classification can move the answer. Keep Jev's output advisory wherever the input is attacker-controlled.

## Workflow for a new integration

1. Write the decision as one sentence: "Given X, which of these N things is it?" If you cannot, it is not a Jev task.
2. Draft the questions and criteria. Read `references/question-design.md`.
3. Build 40 to 100 labelled cases covering every slice you care about (languages, dialects, edge cases). Synthetic is fine and keeps real data out.
4. Run `scripts/eval.py`. Read accuracy, then coverage and accuracy at the gate. Fix criteria, not the gate, until gated accuracy is near 100%.
5. Expect about 3 points of run-to-run noise. Differences under 5 points are not findings.
6. Wire it with the fallback, the timeout and the stored decision record (`references/integration.md`).
7. Run in shadow. Review agreement. Then act above the gate.

## Proven uses (details in `references/patterns.md`)

| Use | Shape | Result measured |
| --- | --- | --- |
| Assistant tool and resource routing hint | 2 choices on the user message, one hint line added to the LLM system prompt above the gate | 100% correct at gate 0.8, 62% coverage, 610 to 690 ms from the server |
| Browser step driver | 1 combined `move` choice + 1 `goal_reached` noul per step over an indexed element list | Logged into an Arabic-rendered app unaided, c=1.00 per step, about 500 ms and USD 0.00006 per step, stopped honestly at c=0.46 |
| UI text judge in QA walks | 1 choice per visible line: customer copy, developer artefact, untranslated key, wrong language | Catches classes a regex list has not met yet |
| First-click navigation tree test | 1 choice per task sentence over the top-level labels, both locales | 110 calls per tree, pennies per run. Object-named folders 92.7% EN and 90.9% AR against 65.5% and 52.7% for the existing layout |
| CI failure triage | choice of bucket (flaky, regression, infra, fixture) + next step | Designed, shadow beside human triage |
| Grade pre-check | contract lines vs builder report: complete, evidence missing, wrong surface | Designed, saves grader seats on obviously incomplete work |
| Finding dedupe and severity | one call per candidate finding | Designed |

## Walking a product (Jev + DeepSeek vision)

Use when asked for a QA walk, a live walk, a smoke tour or "check every page". Split the work by what each model is good at:

- **Jev drives.** Text state, one whole move per option, execute only above the gate, deterministic `reached` check per goal (a regex on the page title). Never ask Jev whether a page looks right.
- **DeepSeek vision looks.** One screenshot per page reached, one call, JSON findings. It catches what a text state cannot show: overlap, clipping, unreadable contrast, raw keys, broken layout. Never let it drive; that is the expensive path.
- **Measured on `examples/demo-app`, 7 moves, one run each:** driving cost $0.00018 with Jev against $0.00126 off-peak ($0.00253 peak) with vision driving, 529 ms against 1,880 ms per move, same 5 of 5 goals, same 3 of 3 planted defects found. Whole walk with reviews: 40% less off-peak, 44% less peak. The review is 88% of the Jev-driven bill, so the saving grows with moves per page.
- **Write the spec, then run it:** `node scripts/walk.mjs --spec walk.json`. Goals run in order and later goals assume earlier ones, so a failed goal ends the walk. Read `walk-report.md` and confirm every finding on its screenshot: vision review can miss and can invent.
- **Show it:** `--watch` runs headed and slowed, with an on-page panel (goal, move, confidence against the gate, state) and records `walk.webm`; `scripts/make-clip.sh` turns it into `walk.mp4` and `walk.gif`. The panel never enters the text state or the reviewed screenshots.
- **Boundary:** screenshots go to the DeepSeek API. Scratch or staging instances, throwaway credentials, no real customer data on screen. Quoted values in goals stay local as `<v0>` placeholders.

## Files

- `references/api.md`: request and response shapes, errors, limits, pricing.
- `references/question-design.md`: how to write questions that calibrate, and the known failure modes of `jev-1.13`.
- `references/patterns.md`: each proven use with its state layout, questions and gotchas.
- `references/integration.md`: modes, fallback, stored record, test list, rollout.
- `scripts/jev.mjs`: zero-dependency client with backoff and a concurrency pool.
- `scripts/eval.py`: labelled-case eval that reports accuracy, coverage and gated accuracy per slice.
- `scripts/browser-loop.mjs`: Playwright loop driven by Jev, stops below the gate.
- `scripts/walk.mjs`: full product walk. Jev drives on text state, DeepSeek vision (`deepseek-flash`) reviews one screenshot per page reached, and a report with findings and costs is written. `--driver vision` runs the baseline.
- `scripts/judge-lines.mjs`: visible-text judge for QA walks.
- `scripts/tree-test.mjs`: first-click tree test for navigation labels.
- `scripts/charts.py` and `data/`: redraw the README charts from the raw routing eval rows.
- `examples/`: tiny runnable inputs for `eval.py`, `judge-lines.mjs` and `tree-test.mjs`.

## Setup

1. Get a key at https://typesafe.ai and put `TYPESAFE_API_KEY=...` in `~/.config/typesafe/env` (chmod 600), or export it. `TYPESAFE_ENV_FILE` points the scripts at another file.
2. Smoke test: `python3 scripts/eval.py --questions examples/questions.json --cases examples/cases.json`. Expect `calls ok 4/4`.

## Authorship

A Maykana open-source project. Co-authored by Noor Elshin and Claude Fable 5.1 (Anthropic) in Claude Code. MIT licence.
