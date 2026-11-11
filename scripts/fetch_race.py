#!/usr/bin/env python3
"""Build public/race.json for the $250 race from Gamdom's dollar leaderboard API.

Uses GAMDOM_API_KEY from the environment. The key is never printed.
Counts whole UTC days: RACE_AFTER .. RACE_BEFORE (override with env vars).
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

AFTER = os.environ.get("RACE_AFTER") or "2026-11-10"
BEFORE = os.environ.get("RACE_BEFORE") or "2026-11-17"
GOAL = float(os.environ.get("RACE_GOAL") or 5000)
OUT = os.environ.get("RACE_OUT") or "public/race.json"
BASE = "https://gamdom.com/api/affiliates/leaderboard"


def mask(name):
    name = str(name or "Player")
    if name.lower() == "hidden user":
        return "Hidden User"
    if len(name) >= 6:
        return name[:2] + "***" + name[-3:]
    return name[:1] + "***"


def fetch(key):
    qs = urllib.parse.urlencode({"apikey": key, "after": AFTER, "before": BEFORE})
    req = urllib.request.Request(
        BASE + "?" + qs,
        headers={"User-Agent": "Mozilla/5.0 (race-updater)", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit("Gamdom API returned HTTP %s" % e.code)
    except Exception as e:
        sys.exit("Gamdom API request failed: %s" % type(e).__name__)


def build(payload):
    if not isinstance(payload, dict) or not payload.get("success") or not isinstance(payload.get("data"), list):
        sys.exit("Unexpected API response (success=%r)" % (isinstance(payload, dict) and payload.get("success")))
    totals = {}
    for u in payload["data"]:
        uid = u.get("user_id")
        name = u.get("username")
        wager = sum(float(m.get("total_wager_usd") or 0) for m in (u.get("wager_data") or []))
        key = ("u", uid) if uid not in (None, -1) else ("h", len(totals))   # each hidden user stays separate
        cur = totals.setdefault(key, {"name": mask(name), "wagered": 0.0})
        cur["wagered"] += wager
    players = [
        {"name": p["name"], "wagered": round(p["wagered"], 2)}
        for p in totals.values()
        if p["wagered"] > 0
    ]
    players.sort(key=lambda p: p["wagered"], reverse=True)
    return {
        "start": AFTER,
        "end": BEFORE,
        "goal": GOAL,
        "totalPlayers": len(players),
        "qualified": sum(1 for p in players if p["wagered"] >= GOAL),
        "players": players[:500],
    }


def main():
    key = os.environ.get("GAMDOM_API_KEY")
    if not key:
        sys.exit("GAMDOM_API_KEY is not set")
    result = build(fetch(key))
    old = None
    if os.path.exists(OUT):
        try:
            old = json.load(open(OUT, encoding="utf-8"))
        except Exception:
            old = None
    if old == result:
        print("No change.")
    else:
        os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=1)
        print("Wrote %s: %d players, %d qualified" % (OUT, result["totalPlayers"], result["qualified"]))


if __name__ == "__main__":
    main()
