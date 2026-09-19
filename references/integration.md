# Integrating Jev into an application

## Configuration

One config block, no new mechanisms:

| Key | Default | Notes |
| --- | --- | --- |
| `api_key` | from env `TYPESAFE_API_KEY` | never logged |
| `model` | `jev-1.13.0` | pinned version, not an alias |
| `timeout_ms` | 1200 | inline calls only |
| `gate` | 0.8 | per workflow once measured |
| `mode` | `off` | `off`, `shadow`, `act` |

Override `mode` per account or tenant with your existing feature-flag mechanism so you can shadow on one account first.

## Modes

- `off`: no HTTP call at all.
- `shadow`: classify after the real work finishes, in a background job. Store the result. Change nothing the user sees.
- `act`: classify inline within the timeout. Act only when every confidence involved clears the gate. Store the result either way.

## Record stored with every decision

`answers` (choice and confidence per question), `model` (from the response), `latency_ms`, `input_tokens`, `mode`, `acted` (bool). A nullable JSON column on the run or request row is enough. Scope it like any other tenant data.

## Payload rule

The request body contains the state you decided on and server-owned questions. No user id, account id, history, record data or UI context. Write a test that asserts the exact body.

## Test list (write these first, with HTTP faked and stray requests blocked)

1. `off` makes no HTTP call.
2. Timeout, 401, 422, 429, 529 and malformed JSON each leave the main flow unchanged.
3. In `shadow`, everything sent to the main LLM is byte-identical to `off`.
4. In `act`, exactly one change is made, and only when all confidences clear the gate.
5. The request body contains only the allowed fields.
6. No billing, metering or wallet call is triggered by a Jev call.
7. Stored decisions are isolated per tenant or account.

## Rollout

1. Offline eval on labelled cases (`scripts/eval.py`). Gated accuracy near 100% or do not ship.
2. Deploy with `mode=off`. Set the key in the deployment environment.
3. `shadow` on one account for about 7 days.
4. Agreement report: stored decision vs what actually happened, broken down per option.
5. `act` above the gate. Keep recording. Re-run the offline eval before moving to a new model version.

## Key handling

- Environment variable first, then a chmod 600 file outside the repository (for example `~/.config/<project>/env`). A gitignored file inside the repo is one `git add -f` away from being published.
- Never on a command line (shell history), never in logs, never in an agent's output.

## Using it from a coding agent's workflow

- Jev is a decision layer in scripts the agent runs: triage, pre-checks, judges, tree tests. The agent still writes the code and an independent grader still grades.
- Keep a pool of 4 to 6 concurrent calls in batch scripts, with backoff on 429 and 529.
- Write results to files (`trace.jsonl`, `verdict.json`, `results/<stamp>.json`) so a later session can read evidence rather than rerun.
