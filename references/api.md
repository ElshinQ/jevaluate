# API reference (jev-1.13.0, checked 2026-09-17)

Official docs: https://docs.typesafe.ai (machine index at https://docs.typesafe.ai/llms.txt). Check them when a shape below fails; the API is young and moves.

## Request

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer $TYPESAFE_API_KEY
Content-Type: application/json
```

```json
{
  "model": "jev-1.13.0",
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this message?",
      "criteria": {
        "billing": "Payments, payouts, invoices, refunds.",
        "technical": "Bugs, errors, outages, integrations.",
        "sales": "Pricing, plans, upgrades, new business."
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    },
    "is_urgent": {
      "type": "noul",
      "instructions": "Does the customer need an answer today? 1 means yes, 0 means no."
    }
  }
}
```

- `state`: a string or a JSON value. JSON lets instructions name parts of it (`items[3]`).
- `questions`: a map. Your keys come back as the answer keys. All questions are processed in parallel over one read of the state, so packing many questions in one call is the cheapest way to use it.
- `choice.criteria`: map of option id to description. `score.criteria`: ordered array of level descriptions, at least two. `noul`: instructions only (criteria optional).

## Response

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "department": {
      "type": "choice",
      "choice": "billing",
      "probabilities": { "billing": 0.85, "technical": 0.08, "sales": 0.07 },
      "confidence": 0.82
    },
    "frustration": {
      "type": "score",
      "score": 1.6,
      "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      "probabilities": { "0": 0.05, "1": 0.3, "2": 0.65 },
      "confidence": 0.78
    },
    "is_urgent": { "type": "noul", "noul": 0.91 }
  },
  "usage": { "input_tokens": 312, "output_tokens": 48 }
}
```

- `confidence` is derived from the distribution and is not the same as the top probability. Gate on `confidence`. Use `probabilities` when you want to rank, sum over several acceptable options, or do your own statistics.
- A noul returns a probability, no confidence field. Gate it directly (for example `>= 0.8` for yes, `<= 0.2` for no, the middle is "unsure").
- `score.score` is a probability-weighted position. Use it against a threshold. Do not interpolate it into an exact number.

## Errors

| Status | Meaning | Handling |
| --- | --- | --- |
| 401 | Bad or missing key | Fail closed to today's behaviour, alert |
| 422 | Validation failure, body names the field | Bug in your payload; log the body |
| 429 | Rate limit | Exponential backoff, honour `retry-after` |
| 529 | Overloaded | Same backoff |

Backoff that worked: `500 ms * 2^attempt`, six retries (seven attempts), for batch jobs. Both clients here honour `Retry-After` as seconds or an HTTP date, capped at 30 s. Inline production calls should not retry; they should time out and fall through.

## Limits and price

- Context: 64k tokens for state plus all questions; 32k for state plus the longest question.
- Published rate: 250,000 tokens per second, 1,200 requests per minute, "adjusting dynamically". Observed: throttling above roughly 8 parallel calls from one client. Use a pool of 4 to 6.
- Price: USD 0.042 per million input tokens. Output free.
- `GET /v1/models` lists aliases. `jev-latest` and `jev-preview` move on release. Versioned ids are accepted even when not listed.

## Latency measured

- Laptop, cold connection: p50 about 1,020 ms, p95 about 1,120 ms (TLS included).
- Warm connection: 200 to 500 ms.
- From a European VPS, cold: 610 to 690 ms, of which about 370 ms is connect plus TLS. Reuse connections where the runtime allows it.
