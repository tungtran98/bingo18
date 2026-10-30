// Builds data.json for the GitHub Pages copy of the Bingo18 page.
// Merges the latest draws from xosohomnay.com and vietlott.vn into the history already published,
// so the page can fill in draws it missed while it was closed.
// Usage: node scripts/fetch-data.js <output file> [published data.json URL]
const https = require("https"), fs = require("fs"), path = require("path");

const OUT = process.argv[2] || "_site/data.json";
const PREV = process.argv[3]; // currently published data.json, carried forward
const GAME = "https://xosohomnay.com/vietlott/bingo18";
const VIETLOTT = "https://vietlott.vn/vi/trung-thuong/ket-qua-trung-thuong/winning-number-bingo18";
const MAX_DRAWS = 5000; // about a month of draws

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

// Each source returns rows [drawNo, d1, d2, d3, "dd-mm-yyyy"]
async function xosohomnay(day) {
  const text = plain(await get(`${GAME}/${day}`));
  return [...text.matchAll(/#?(\d{6,7}) ([1-6]) ([1-6]) ([1-6]) Tổng/g)].map(m => [+m[1], +m[2], +m[3], +m[4], day]);
}
async function vietlott() {
  const text = plain(await get(VIETLOTT));
  return [...text.matchAll(/(\d{2})\/(\d{2})\/(\d{4}) #0*(\d{6,7}) ([1-6]) ([1-6]) ([1-6]) \d+/g)]
    .map(m => [+m[4], +m[5], +m[6], +m[7], `${m[1]}-${m[2]}-${m[3]}`]);
}
async function previous() {
  if (!PREV) return [];
  return JSON.parse(await get(`${PREV}?_=${Date.now()}`)).draws;
}

(async () => {
  const sources = { previous: previous(), today: xosohomnay(dayVN()), yesterday: xosohomnay(dayVN(-1)), vietlott: vietlott() };
  const draws = new Map();
  for (const [name, p] of Object.entries(sources)) {
    try {
      const rows = await p;
      rows.forEach(r => { if (!draws.has(r[0]) || name !== "previous") draws.set(r[0], r); });
      console.log(`${name}: ${rows.length} draws`);
    } catch (e) {
      console.log(`${name}: failed (${e.message})`);
    }
  }
  const list = [...draws.values()].sort((a, b) => a[0] - b[0]).slice(-MAX_DRAWS);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), draws: list }));
  console.log(`wrote ${list.length} draws to ${OUT}`);
})();
