# Writing questions that calibrate

## The shape of a good question

- `instructions` says what the state is, then asks one direct question. Example: "The state is one message a user typed to the assistant of a business application. It may be English, Arabic, a dialect, Arabic in Latin letters, or a mix. What does the user want the assistant to do?"
- Every option has a full descriptive sentence, not a label. `purchase_orders: "Orders WE place with suppliers to buy goods."` beats `purchase_orders: "Purchase orders"`.
- Disambiguate near neighbours inside the criteria. Capitalise the distinguishing word: quotations "WE send to customers" vs quotations "SUPPLIERS sent to us".
- Always include an escape option: `none`, `other`, `stuck`, `not stated`. Without it the mass lands on a wrong real option with false confidence.
- Instructions and criteria must agree. A noul where 1 means "no" performs worse. State the polarity: "1 means yes, 0 means no".

## Merge dependent decisions, split independent ones

- Dependent (action + target + value): one choice whose options are complete statements. Separate questions marginalise and neither clears the gate.
- Independent (operation vs record type, department vs urgency): separate questions in the same call. Gate on `min(confidence)` across every question the action depends on.
- Speculative fan-out is cheap: ask questions you might not need, decide in code which answers matter.

## Multilingual

- Bilingual criteria (`"Find or list records (بحث أو عرض قائمة سجلات)"`) held accuracy on Arabic and dialect input at a cost of about 500 extra tokens per call. Worth it.
- Dialect and mixed-script input stays correct at the gate but coverage drops (73% English and Standard Arabic, 47% dialect, 53% mixed). Plan for more fall-through there, not more errors.
- Say the interface language in the state when judging UI text.

## Iterating

- Look at every wrong answer. The fix is nearly always a criterion, rarely the gate.
- Real examples of rubric fixes: `stock_counts` had to say "physical count sessions, not current quantities"; a missing `letters` option sent letter requests to `documents`.
- A gate is not one number. The vendor's guidance, which matches our use: scale the threshold with the cost of being wrong. A read-only hint can act at 0.8; anything destructive needs more, or a person.
- Keep the gate at 0.8 until a workflow has its own measured curve. Plot confidence against correctness on your cases before moving it.
- If you only need the best option and will act regardless, take the top probability and skip the gate. Gates are for deciding whether to act.
- Noise is about 3 points between identical runs. Rerun before believing a small gain.
- The person who wrote the options should not be the only one who wrote the test cases. Have someone else rewrite a third of them.

## Known failure modes of jev-1.13 (vendor list, reviewed 2026-09-16)

| Failure | Do this instead |
| --- | --- |
| Literal reading: scoping words, negations and implied conditions are taken at face value | Write the exact condition; put boundary cases in the criteria; split an interpretive question into two literal ones and combine in code |
| Counting (characters, occurrences, list items) | Count in code. For "how many match", ask one noul per item and sum |
| Arithmetic and numeric closeness (hex colours, amounts) | Compute in code, pass a named bucket ("over budget") |
| Date and time comparison | Extract parts as choices (month, day, year, "not stated"), assemble and compare in code |
| Indirection, double negatives, multi-hop reasoning | One hop per question; name the part of state to look at |
| Large state with irrelevant detail | Filter in code first; or a noul relevance pass per passage |
| Adversarial or self-describing content in state | Precise criteria, test hostile cases, keep the output advisory |
| Text generation | Use a generative model. For extraction, generate candidates with regex or an LLM and let Jev choose among them |

## Things it cannot do, so do not try

- See a screenshot. Feed it the accessibility tree or visible text.
- Return a string it invented. Offer candidate strings as options (we extract quoted literals and email addresses from the goal and offer those).
- Be the judge of whether work is correct. It can say "this report does not mention evidence for line 3" cheaply; it cannot verify the evidence.
