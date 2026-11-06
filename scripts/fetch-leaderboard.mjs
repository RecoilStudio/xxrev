// Fetches the Gamdom affiliate wager leaderboard and writes:
//   leaderboard.json              the current month, read by the website
//   snapshots/YYYY-MM.json        a record of each month (kept for paying out)
// Usernames are masked here, so full names and user IDs never reach the public repo.
// The API key comes from the GAMDOM_API_KEY environment variable (GitHub secret). It is never logged.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const KEY = process.env.GAMDOM_API_KEY;
const API = process.env.GAMDOM_API_URL || "https://gamdom.com/api/affiliates/leaderboard";
const MAX = Number(process.env.LB_MAX_PLAYERS) || 50;   // players written to the file
const FORCE_MONTH = process.env.LB_MONTH;               // optional, e.g. 2026-11. Normally the current UTC month is used

const fail = msg => { console.error("ERROR: " + msg); process.exit(1); };
if (!KEY) fail("GAMDOM_API_KEY is not set. Add it as a repository secret.");
if (FORCE_MONTH && !/^\d{4}-\d{2}$/.test(FORCE_MONTH)) fail("LB_MONTH must look like 2026-11");

const now = new Date();
const ym = d => d.toISOString().slice(0, 7);
const current = FORCE_MONTH || ym(now);
const previous = ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
// For the first 12 hours of a new month also refresh last month's snapshot, so late settlements and refunds are captured.
const months = [current];
if (!FORCE_MONTH && now.getUTCDate() === 1 && now.getUTCHours() < 12) months.push(previous);

// One call returns every month, grouped by month, so there are no date parameters to get wrong.
const url = new URL(API);
url.searchParams.set("apikey", KEY);
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

function board(month) {
  const list = [];
  for (const r of rows) {
    const m = (Array.isArray(r?.wager_data) ? r.wager_data : []).find(w => w && w.month === month);
    const usd = Number(m?.total_wager_usd);
    if (Number.isFinite(usd) && usd > 0) list.push({ name: mask(r), wagered: Math.round(usd * 100) / 100 });
  }
  list.sort((a, b) => b.wagered - a.wagered);
  return { month, updated: now.toISOString(), totalPlayers: list.length, players: list.slice(0, MAX) };
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

await save("leaderboard.json", board(current));
for (const m of months) await save(`snapshots/${m}.json`, board(m));
