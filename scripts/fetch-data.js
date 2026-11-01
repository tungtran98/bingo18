// Builds data.json for the GitHub Pages copy of the Bingo18 page.
// Merges the latest draws from xosohomnay.com and vietlott.vn into the history already known,
// and fills in whole past days that are still incomplete, so draw-gap statistics have every draw.
// Usage: node scripts/fetch-data.js <output file> [history file or published data.json URL ...]
const https = require("https"), fs = require("fs"), path = require("path");

const OUT = process.argv[2] || "_site/data.json";
const SOURCES = process.argv.slice(3); // history carried forward: local files and/or the published data.json
const GAME = "https://xosohomnay.com/vietlott/bingo18";
const VIETLOTT = "https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/winning-number-bingo18";
const HISTORY_DAYS = +process.env.HISTORY_DAYS || 45; // about 7,000 draws: long enough for the rarest gaps (triples)
const MAX_DRAWS = 8000;
const BACKFILL_DAYS_PER_RUN = +process.env.BACKFILL_DAYS_PER_RUN || 3; // a full day costs about 8 requests
const PARALLEL = 3; // the source resets connections when hit too hard

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, r => {
      if (r.statusCode !== 200) { r.resume(); return reject(new Error(`HTTP ${r.statusCode} ${url}`)); }
      let body = ""; r.setEncoding("utf8");
      r.on("data", c => body += c); r.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("timeout " + url)));
  });
}
const plain = html => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
// Vietnam time, dd-mm-yyyy
const dayVN = (offsetDays = 0) => new Date(Date.now() + 7 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10).split("-").reverse().join("-");
const rowsOf = (html, day) => [...plain(html).matchAll(/#?(\d{6,7}) ([1-6]) ([1-6]) ([1-6]) Tổng/g)].map(m => [+m[1], +m[2], +m[3], +m[4], day]);

// Each source returns rows [drawNo, d1, d2, d3, "dd-mm-yyyy"]
// A day page lists the newest 20 draws; "?them=N" returns the next older ones, up to the day's total (data-tong).
// Paging stops early once it reaches a draw already known.
async function xosohomnayDay(day, known) {
  const html = await get(`${GAME}/${day}`);
  const total = +(html.match(/class="kyds" data-tong="(\d+)"/) || [])[1] || 0;
  const rows = rowsOf(html, day);
  while (rows.length < total && !rows.some(r => known.has(r[0]))) {
    const more = rowsOf(await get(`${GAME}/${day}?them=${rows.length}`), day);
    if (!more.length) break;
    rows.push(...more);
  }
  return { rows, total };
}
async function vietlott() {
  const text = plain(await get(VIETLOTT));
  return [...text.matchAll(/(\d{2})\/(\d{2})\/(\d{4}) #0*(\d{6,7}) ([1-6]) ([1-6]) ([1-6]) \d+/g)]
    .map(m => [+m[4], +m[5], +m[6], +m[7], `${m[1]}-${m[2]}-${m[3]}`]);
}
async function history(src) {
  const read = /^https?:/.test(src) ? () => get(`${src}?_=${Date.now()}`) : async () => fs.readFileSync(src, "utf8");
  try { const o = JSON.parse(await read()); return { draws: o.draws || [], days: o.days || {} }; }
  catch (e) { if (/HTTP 404|ENOENT/.test(e.message)) return { draws: [], days: {} }; throw e; } // not published yet
}
// Runs async jobs with at most n in flight; resolves like Promise.allSettled
async function pool(jobs, n) {
  const out = []; let next = 0;
  const worker = async () => { while (next < jobs.length) { const i = next++; try { out[i] = { status: "fulfilled", value: await jobs[i]() }; } catch (reason) { out[i] = { status: "rejected", reason }; } } };
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}

(async () => {
  const draws = new Map(), days = {}; // days: past date -> number of draws listed that day, once fully fetched
  const take = (name, rows) => { rows.forEach(r => draws.set(r[0], r)); console.log(`${name}: ${rows.length} draws`); };

  // Publishing without the old history would wipe what the page relies on: keep the live site instead
  for (const src of SOURCES) {
    let h;
    try { h = await history(src); } catch (e) { console.log(`not publishing: history unavailable (${e.message})`); process.exit(1); }
    take(src, h.draws);
    Object.assign(days, h.days);
  }
  const known = new Set(draws.keys());
  const perDay = new Map(); draws.forEach(r => perDay.set(r[4], (perDay.get(r[4]) || 0) + 1));

  // Today is always refreshed; past days only until they are complete
  const wanted = [dayVN()];
  for (let i = 1; i <= HISTORY_DAYS && wanted.length <= BACKFILL_DAYS_PER_RUN; i++) {
    const day = dayVN(-i);
    if (!days[day] || (perDay.get(day) || 0) < days[day]) wanted.push(day);
  }
  // Past days are fetched whole, so their total can be checked
  const results = await pool([...wanted.map((day, i) => () => xosohomnayDay(day, i ? new Set() : known)), vietlott], PARALLEL);
  results.forEach((res, i) => {
    const name = i < wanted.length ? wanted[i] : "vietlott";
    if (res.status === "rejected") return console.log(`${name}: failed (${res.reason.message})`);
    if (i === wanted.length) return take(name, res.value);
    const { rows, total } = res.value;
    take(`${name} (day total ${total})`, rows);
    // Today is still being drawn, so only past days are marked complete
    if (i > 0 && total && rows.length >= total) days[name] = total;
  });
  if (!draws.size) { console.log("not publishing: no draws"); process.exit(1); }

  const list = [...draws.values()].sort((a, b) => a[0] - b[0]).slice(-MAX_DRAWS);
  const kept = new Set(list.map(r => r[4]));
  Object.keys(days).forEach(d => { if (!kept.has(d)) delete days[d]; });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), days, draws: list }));
  console.log(`wrote ${list.length} draws (#${list[0][0]}..#${list[list.length - 1][0]}) to ${OUT}`);
})();
