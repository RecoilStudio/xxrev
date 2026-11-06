// Fetches the Gamdom affiliate wager leaderboard and writes:
//   leaderboard.json              the period LB_START to LB_END (or the current month), read by the website
//   snapshots/YYYY-MM.json        a record of each month on its own (kept for paying out)
// Usernames are masked here, so full names and user IDs never reach the public repo.
// The API key comes from the GAMDOM_API_KEY environment variable (GitHub secret). It is never logged.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const KEY = process.env.GAMDOM_API_KEY;
const API = process.env.GAMDOM_API_URL || "https://gamdom.com/api/affiliates/leaderboard";
const MAX = Number(process.env.LB_MAX_PLAYERS) || 25;   // players written to the file (the site shows only the paid places)
// Where the website lives. The files are written next to index.html: in public/ if that is where it is, otherwise the repo root.
const OUT = process.env.LB_DIR ?? (existsSync("public/index.html") ? "public" : ".");

const fail = msg => { console.error("ERROR: " + msg); process.exit(1); };
if (!KEY) fail("GAMDOM_API_KEY is not set. Add it as a repository secret.");

const now = new Date();
const ym = d => d.toISOString().slice(0, 7);
const iso = d => d.toISOString().slice(0, 10);
const isDay = s => /^\d{4}-\d{2}-\d{2}$/.test(s || "") && iso(new Date(s + "T00:00:00Z")) === s;

// The period the leaderboard covers, both days included (UTC). Set LB_START and LB_END in the workflow.
// Leave both empty to follow the current calendar month automatically.
const auto = !process.env.LB_START && !process.env.LB_END;
let START = process.env.LB_START, END = process.env.LB_END;
if (auto) {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  START = iso(new Date(Date.UTC(y, m, 1)));
  END = iso(new Date(Date.UTC(y, m + 1, 0)));
}
if (!isDay(START) || !isDay(END) || START > END) fail("LB_START and LB_END must both be set as YYYY-MM-DD, with the start not after the end");
if (process.env.LB_AFTER && !isDay(process.env.LB_AFTER)) fail("LB_AFTER must look like 2026-10-22");

// The API groups wagers by month, so the period is the sum of the months it touches.
const rangeMonths = [];
{
  let y = +START.slice(0, 4), m = +START.slice(5, 7);
  const ey = +END.slice(0, 4), em = +END.slice(5, 7);
  while (y < ey || (y === ey && m <= em)) { rangeMonths.push(`${y}-${String(m).padStart(2, "0")}`); if (++m > 12) { m = 1; y++; } }
}
if (rangeMonths.length > 14) fail("The period is too long (14 months at most)");
if (!START.endsWith("-01") || END !== iso(new Date(Date.UTC(+END.slice(0, 4), +END.slice(5, 7), 0)))) {
  console.log(`Note: ${START} to ${END} does not start/end on a month edge. Wagers are grouped by month, so ${rangeMonths[0]} and ${rangeMonths[rangeMonths.length - 1]} are counted in full. That is exact only if nothing was wagered outside the dates.`);
}
// Also keep a per-month record. For the first 12 hours of a new month, refresh last month's too, so late refunds are captured.
const snapMonths = [...rangeMonths];
if (auto && now.getUTCDate() === 1 && now.getUTCHours() < 12) snapMonths.push(ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))));

// One call returns every month, grouped by month, so there are no date parameters to get wrong.
const url = new URL(API);
url.searchParams.set("apikey", KEY);
if (process.env.LB_AFTER) url.searchParams.set("after", process.env.LB_AFTER);   // optional date filter, off by default
let res, text;
try {
  res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30000) });
  text = await res.text();
} catch (e) {
  fail("Could not reach the API: " + (e.cause?.code || e.name));
}
let body;
try { body = JSON.parse(text); } catch { fail(`API returned something that is not JSON (HTTP ${res.status})`); }
if (!res.ok || !body || body.success !== true) fail(`API error (HTTP ${res.status}): ${body?.message ?? "no message"}`);

const rows = body.data;
if (!Array.isArray(rows)) fail("Unexpected response shape: data is not a list");
if (rows.length && !rows.some(r => Array.isArray(r?.wager_data))) fail("Unexpected response shape: no wager_data found");

function mask(r) {
  const n = String(r.username ?? "").trim();
  if (r.user_id === -1 || !n || /^hidden user$/i.test(n)) return "Hidden user";
  const c = [...n];
  if (c.length <= 4) return c[0] + "***";
  if (c.length <= 7) return c.slice(0, 2).join("") + "***";
  return c.slice(0, 2).join("") + "***" + c.slice(-3).join("");
}

function board(ms, extra) {
  const want = new Set(ms);
  const list = [];
  for (const r of rows) {
    let usd = 0;
    for (const w of Array.isArray(r?.wager_data) ? r.wager_data : []) {
      const v = Number(w?.total_wager_usd);
      if (w && want.has(w.month) && Number.isFinite(v)) usd += v;
    }
    if (usd > 0) list.push({ name: mask(r), wagered: Math.round(usd * 100) / 100 });
  }
  list.sort((a, b) => b.wagered - a.wagered);
  return { ...extra, updated: now.toISOString(), totalPlayers: list.length, players: list.slice(0, MAX) };
}

async function save(path, obj) {
  let old;
  try { old = JSON.parse(await readFile(path, "utf8")); } catch {}
  const core = o => JSON.stringify({ ...o, updated: undefined });
  if (old && core(old) === core(obj)) return console.log(`${path}: unchanged`);
  if (old && old.totalPlayers > 0 && obj.totalPlayers === 0) return console.warn(`${path}: API returned no players, keeping the existing file`);
  await mkdir(dirname(path) || ".", { recursive: true });
  await writeFile(path, JSON.stringify(obj, null, 1) + "\n");
  console.log(`${path}: updated (${obj.totalPlayers} players)`);
}

console.log(`Writing to ${OUT === "." ? "the repo root" : OUT + "/"}`);
await save(join(OUT, "leaderboard.json"), board(rangeMonths, { start: START, end: END, month: END.slice(0, 7) }));
for (const m of snapMonths) await save(join(OUT, "snapshots", `${m}.json`), board([m], { month: m }));
