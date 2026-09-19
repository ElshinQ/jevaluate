#!/usr/bin/env python3
"""Labelled-case eval for a set of Jev choice questions. Standard library only.

    python3 eval.py --questions questions.json --cases cases.json [--gate 0.8] [--model jev-1.13.0] [--limit N]

questions.json: the exact `questions` map you will send in production.
cases.json:     [{"id": "en01", "slice": "en", "text": "<state>", "gold": {"<question id>": ["ok_option", ...]}}, ...]
                `gold` lists every acceptable option per question. Use synthetic text; keep real data out.

Prints per-case lines, then per-slice accuracy, coverage at the gate and accuracy at the gate.
The number that matters is accuracy at the gate: it should be near 100% before you act on answers.
Reads TYPESAFE_API_KEY from the environment or TYPESAFE_ENV_FILE (default ~/.config/typesafe/env). Never prints it.
"""
import argparse
import email.utils
import json
import math
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

ENDPOINT = "https://api.typesafe.ai/v1/systemone"
PRICE_PER_MTOK = 0.042


def load_key():
    key = os.environ.get("TYPESAFE_API_KEY")
    if key:
        return key
    env = Path(os.environ.get("TYPESAFE_ENV_FILE", Path.home() / ".config/typesafe/env"))
    if env.exists():
        for line in env.read_text().splitlines():
            line = line.strip().removeprefix("export ").strip()
            if line.startswith("TYPESAFE_API_KEY="):
                return line.split("=", 1)[1].strip().strip("'\"")
    sys.exit(f"TYPESAFE_API_KEY not found in environment or {env}")


def retry_after(header):
    """Retry-After is delta-seconds or an HTTP date. Returns a bounded wait in seconds, or None."""
    if not header:
        return None
    try:
        secs = float(header)
    except ValueError:
        try:
            secs = email.utils.parsedate_to_datetime(header).timestamp() - time.time()
        except (TypeError, ValueError):
            return None
    return min(secs, 30.0) if secs > 0 else None


def call(key, model, state, qs):
    body = json.dumps({"model": model, "state": state, "questions": qs}, ensure_ascii=False).encode()
    for attempt in range(7):
        req = urllib.request.Request(
            ENDPOINT, data=body, method="POST",
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        )
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read()), time.perf_counter() - t0, None
        except urllib.error.HTTPError as e:
            if e.code in (429, 529) and attempt < 6:  # six retries, seven attempts
                time.sleep(retry_after(e.headers.get("Retry-After")) or 0.5 * 2 ** attempt)
                continue
            return None, time.perf_counter() - t0, f"HTTP {e.code}: {e.read()[:300].decode(errors='replace')}"
        except Exception as e:  # noqa: BLE001
            return None, time.perf_counter() - t0, repr(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--questions", required=True)
    ap.add_argument("--cases", required=True)
    ap.add_argument("--model", default="jev-1.13.0")
    ap.add_argument("--gate", type=float, default=0.8)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--out", default="results")
    args = ap.parse_args()

    key = load_key()
    qs = json.loads(Path(args.questions).read_text())
    cases = json.loads(Path(args.cases).read_text())
    if args.limit:
        cases = cases[: args.limit]
    if not cases:
        sys.exit("no cases to run")
    for c in cases:
        if not c.get("gold"):
            sys.exit(f"case {c.get('id')} has an empty gold map")
        for qid in c["gold"]:
            if qs.get(qid, {}).get("type") != "choice":
                sys.exit(f"case {c.get('id')}: gold names '{qid}', which is not a choice question in {args.questions}. "
                         "This harness scores choice questions only.")

    rows, lat, tokens, models = [], [], 0, set()
    for c in cases:
        data, secs, err = call(key, args.model, c["text"], qs)
        row = {"id": c["id"], "slice": c.get("slice", "all"), "text": c["text"], "latency_ms": round(secs * 1000)}
        if err:
            row["error"] = err
            print(f"{c['id']} ERROR {err}")
            rows.append(row)
            continue
        answers = data.get("answers") or {}
        bad = [q for q in c["gold"] if not isinstance(answers.get(q), dict) or "choice" not in answers[q]]
        if bad:
            row["error"] = f"response missing a choice answer for: {', '.join(bad)}"
            print(f"{c['id']} ERROR {row['error']}")
            rows.append(row)
            continue
        lat.append(secs * 1000)
        models.add(data.get("model"))
        tokens += (data.get("usage") or {}).get("input_tokens", 0)
        row["q"] = {}
        for qid, gold in c["gold"].items():
            a = answers[qid]
            row["q"][qid] = {"choice": a["choice"], "confidence": a.get("confidence", 0.0), "ok": a["choice"] in gold}
        row["ok"] = all(v["ok"] for v in row["q"].values())
        row["min_conf"] = min(v["confidence"] for v in row["q"].values())
        parts = "  ".join(f"{qid} {'ok ' if v['ok'] else 'BAD'} {v['choice']:<18} c={v['confidence']:.2f}" for qid, v in row["q"].items())
        print(f"{c['id']:<8}{row['latency_ms']:>5}ms  {parts}")
        rows.append(row)

    out = Path(args.out)
    out.mkdir(exist_ok=True)
    (out / f"{time.strftime('%Y%m%d-%H%M%S')}.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))

    good = [r for r in rows if "error" not in r]
    print(f"\nmodel(s) answered: {sorted(m for m in models if m)}")
    print(f"calls ok {len(good)}/{len(rows)}  input tokens {tokens}  est cost ${tokens * PRICE_PER_MTOK / 1e6:.5f}"
          f"  avg tokens/call {tokens // max(len(good), 1)}")
    if lat:
        s = sorted(lat)
        print(f"latency ms p50 {statistics.median(s):.0f}  p95 {s[math.ceil(0.95 * len(s)) - 1]:.0f}  max {s[-1]:.0f}")

    if not good:
        sys.exit("every call failed; nothing to score")
    by = defaultdict(list)
    for r in good:
        by[r["slice"]].append(r)
        by["ALL"].append(r)
    print(f"\n{'slice':<10}{'n':>4} {'all ok':>8}   gate>={args.gate}: {'coverage':>9} {'accuracy':>9}")
    for sl in [k for k in by if k != "ALL"] + ["ALL"]:
        rs = by[sl]
        n = len(rs)
        acc = [r for r in rs if r["min_conf"] >= args.gate]
        gacc = f"{sum(r['ok'] for r in acc) / len(acc):.0%}" if acc else "n/a"
        print(f"{sl:<10}{n:>4} {sum(r['ok'] for r in rs) / n:>8.0%}   {'':>11}{len(acc) / n:>9.0%} {gacc:>9}")
    wrong_confident = [r["id"] for r in good if not r["ok"] and r["min_conf"] >= args.gate]
    print(f"\nwrong AND above the gate (fix criteria for these first): {wrong_confident or 'none'}")


if __name__ == "__main__":
    main()
