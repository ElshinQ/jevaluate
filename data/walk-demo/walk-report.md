# Walk report

- Driver: Jev (text state, whole moves), gate 0.8
- Goals reached: 5 of 5 in 22 s
- Driving: 7 calls, 4359 tokens, 529 ms average, $0.00018 off-peak / $0.00018 peak
- Visual review: 5 calls, 5491 tokens, $0.00133 off-peak / $0.00266 peak

## Goals

| Goal | Status | Moves | Review |
|---|---|---|---|
| login | reached | 3 | clean (0) |
| contacts | reached | 1 | clean (0) |
| invoices | reached | 1 | defects (1) |
| reports | reached | 1 | defects (1) |
| settings | reached | 1 | defects (1) |

## Findings

| Page | Severity | Where | Issue |
|---|---|---|---|
| invoices | medium | empty-state card heading in the middle of the Invoices page | The card title shows the raw translation key "invoices.empty_state.title" instead of readable English copy. |
| reports | medium | Reports card, subtitle line under the 'This quarter' heading | The sentence 'Revenue is up 12% on last quarter across 48 paid invoices.' is rendered in a very pale gray on the white card and is barely legible. |
| settings | high | Settings card, helper text directly above/below the form ('Changes apply to every organisation.') | The blue 'Save changes' button is rendered on top of the helper sentence, hiding the words between 'ev' and 'organisation' so the text reads as 'Changes apply to ev...organisation.'. |

A vision model can miss defects and can invent them. Treat every finding as a lead to confirm on the screenshot beside this file.
