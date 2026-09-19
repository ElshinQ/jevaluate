# Proven patterns

Each entry: what goes in, what is asked, what the code does with the answer, and what went wrong on the way.

## 1. Routing hint in front of an LLM assistant

Problem: a tool-calling assistant picked the wrong tool or record type, and the fixes were keyword rules applied after the model, one new rule per new phrasing.

- State: the current user message only.
- Questions: `operation` (12 options) and `resource` (about 22 options plus `none`), both choices, bilingual criteria.
- Action: if both confidences clear 0.8, append exactly one line to the system instruction: `Routing hint: the user most likely wants <operation> on <resource>. Ignore it if it does not fit.` Otherwise change nothing.
- **Never narrow the declared tools or enums based on the hint.** Declarations stay byte-identical, so the provider's prompt cache still hits and a wrong hint cannot remove the right tool.
- The hint names a category only. Never amounts, ids, dates or filters.
- Shadow mode runs the classification in a queued job after the turn finishes, so the user pays zero latency while you collect agreement data.
- Go or no-go instrument: a report command that compares the stored hint with the tools the run actually called, per operation and resource.
- Do not route Jev calls through usage meters or wallets that bill the end user.

## 2. Browser step driver and step judge (`scripts/browser-loop.mjs`)

- State per step: goal, allowed typeable strings, URL, page title, an indexed list of visible interactive elements (tag, type, name, label, **current value**), and the steps taken so far.
- Questions: one `move` choice whose options are whole moves (`fill_<idx>_v<n>`, `click_<idx>`, `done`, `stuck`), plus a `goal_reached` noul.
- Harness: executes only when `move.confidence >= gate`. `done` also needs `goal_reached >= gate`. Below the gate it stops and writes a trace for a human. A deny-list regex blocks destructive clicks regardless of confidence.
- Measured: 5 calls, about 1,500 tokens each, 513 ms average, about USD 0.0003 for a full login on an Arabic-rendered page. It stopped at c=0.46 when a desktop-style shell needed a double click it had no option for. That stop is the feature.
- Lessons:
  - Separate action, target and value questions do not calibrate. Combined moves do.
  - Without current field values the model refills completed fields.
  - Typeable strings come from the goal (quoted literals, email addresses), capped at 3. This also keeps real data out of the payload.
  - Skip debug toolbars and other dev chrome when capturing elements.
  - Capture `[role="menuitem"]` if the app uses flyout menus; add a repeat-move guard; add a verification step after clicks that should open something.
  - For anything visual, pair it with a vision model. Jev reads text only.

## 2b. Full product walk with a vision reviewer (`scripts/walk.mjs`)

Split a QA walk by what each model is good at. Jev drives on the same text state and whole-move options as the browser loop. Each goal carries a deterministic `reached` check (a regex on the page title), so no model decides when a goal is done. On arrival one screenshot goes to DeepSeek vision (`deepseek-flash`, OpenAI-compatible chat completions, image as a base64 `image_url`, `response_format: json_object`), which reports only defects visible in the pixels.

Measured on `examples/demo-app` (invented app, three planted defects), 7 moves, one run per driver, 2026-09-19:

| | Jev drives | DeepSeek vision drives |
|---|---|---|
| Goals reached, defects found | 5 of 5, 3 of 3 | 5 of 5, 3 of 3 |
| Driving cost off-peak / peak | $0.00018 | $0.00126 / $0.00253 |
| Latency per move | 529 ms | 1,880 ms |
| Whole walk with 5 reviews, off-peak | $0.00151 | $0.00254 |

A screenshot cost about 870 input tokens at the default detail level. The review is 88% of the Jev-driven bill, so the whole-walk saving grows with moves per page. One run each: treat the ratios as indicative. Vision review can miss and invent; confirm each finding on its screenshot. Screenshots leave the machine, so staging only.

## 3. Visible-text judge for QA walks (`scripts/judge-lines.mjs`)

- State: one visible line of UI text, cut to 600 characters. One call per line, pool of 4.
- Question: `kind` choice: `customer_copy`, `developer_artifact`, `untranslated_key`, `wrong_language`. The interface language is stated in the instructions.
- Result handling: flagged = not customer copy at or above the gate; unsure = below the gate, shown to a human. Errors never fail the walk.
- Runs beside a deterministic regex check, not instead of it. The regex catches known classes for free; Jev catches the ones you have not met.
- Pass chrome text only (empty panels, labels, buttons). Never model answers or customer records.

## 4. First-click tree test for navigation (`scripts/tree-test.mjs`)

Cheap stand-in for a first-click usability study when deciding folder names and groupings.

- Inputs: `tasks.json` (one realistic task sentence per destination, per locale) and a tree file (top-level labels and which destinations each holds).
- State: who the person is, interface language, what they want to do, and the list of labels on screen.
- Question: "Which single icon would this person open first? Judge by the label alone, as a newcomer."
- Score: correct when the chosen label holds the destination. Report hit rate, gated hit rate and mean probability on the right label, per locale and per folder.
- What it found (55 destinations, 2 locales, 110 calls per tree): the existing desktop with 21 icons and folders named after org units ("Operations", "Resources", "Leadership") scored 65.5% EN and 52.7% AR. Thirteen icons named after objects ("Customers", "Purchasing", "Assets") scored 92.7% and 90.9%. A rival proposal of eight short job labels ("Sell", "Buy", "Govern") scored 58.2% and 61.8%, below the existing desktop in English. One relabel ("Sales" to "Sales & Marketing") moved a lost app to p=0.96.
- A correction worth copying: the first run counted apps that are not desktop icons at all, as targets and as distractors. A second reviewer caught it. Build the tree from what the user can actually see, and make the inventory parser fail loudly when the source drifts.
- Limits: a calibrated proxy for a newcomer, not a user. Confirm with five real people. About 3 points of noise, so ignore gaps under 5. Tasks and trees written by the same person bias the result; have someone else rewrite a third of the tasks. First click only.

## 5. CI failure triage (designed, run in shadow first)

- State: the last 40 to 80 lines of the red log, filtered to the failing job.
- Questions: `bucket` (flaky, regression, infra, fixture) and `next` (rerun, send back to the builder, report to a human).
- Action: store beside the human's call for 7 days. Then rerun or re-dispatch automatically at high confidence; escalate the rest.

## 6. Grade pre-check before an expensive grader (designed)

- State: the done-contract lines and the builder's report.
- Question per contract line, or one choice: `complete`, `evidence_missing`, `wrong_surface`.
- Action: print the verdict next to the real grade. It front-runs the grader so obviously incomplete work goes back without burning a grader run. It never replaces the independent grader.

## 7. Finding dedupe and severity in bug hunts (designed)

- State: one candidate finding plus the titles of confirmed findings.
- Questions: `duplicate_of` (choice over existing ids plus `new`), `severity` (score), `repro_available` (noul).

## 8. Candidate scoring in automated research loops (designed)

- Choice: `keep`, `refute`, `runner_defect`. Classifies harness failures for pennies before a costly scoring seat looks at them.

## Patterns from the vendor docs worth knowing

- Speculative fan-out: many questions per call, code decides relevance.
- Confidence-gated routing: answer says what, confidence says whether.
- Composite scoring: several atomic scores, weights in code, so you can see and tune why something ranked.
- Intent routing: send each request to deterministic code, a specialist LLM, or a human.
- Date extraction as choices over month, day, year with a "not stated" option.
