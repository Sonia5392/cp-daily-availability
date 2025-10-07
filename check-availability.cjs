// ChiliPiper checker (CommonJS) — scans ALL frames for time slots
// NO Slack/CSV. Writes availability.json for your Pages dashboard.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// Load config
const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), "links.json"), "utf8"));
const TZ = process.env.TZ || config.timezone || "America/New_York";
const MIN_SLOTS = Number(config.minSlots || 3);
const MAX_MONTHS = Number(config.maxMonthsToScan || 6);
const LINKS = config.links || [];

// ---------- helpers ----------
function midnight(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
function daysFromTodayISO(iso){ return Math.round((midnight(iso)-midnight(new Date()))/86400000); }

function monthIndexFromName(name) {
  const m = (name || "").toLowerCase();
  const list = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const i = list.findIndex(n => m.startsWith(n));
  return i >= 0 ? i : null;
}
function toISO(y, mIdx, day) {
  return `${y}-${String(mIdx+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
}
function parseISOFromAria(label) {
  if (!label) return null;
  let m = label.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (m) return m[1];
  m = label.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})/i);
  if (m) { const mi = monthIndexFromName(m[1]); if (mi !== null) return toISO(Number(m[3]), mi, Number(m[2])); }
  return null;
}

async function tryAcceptCookies(target) {
  const labels = [/accept/i, /agree/i, /allow all/i, /got it/i, /^ok$/i];
  const els = await target.$$("button, [role=button]").catch(()=>[]);
  for (const el of els || []) {
    const txt = (await el.textContent())?.trim() || "";
    if (labels.some(rx => rx.test(txt))) {
      try { await el.click({ timeout: 500 }); await target.waitForTimeout(250); } catch {}
    }
  }
}

async function getMonthHeader(frame) {
  const sels = [
    '[aria-live="polite"]',
    '[data-testid*="current-month"]',
    '.DayPicker-Caption',
    '.react-datepicker__current-month',
    'header h2, h2'
  ];
  for (const s of sels) {
    const el = await frame.$(s);
    if (!el) continue;
    const txt = (await el.textContent())?.trim() || "";
    const m = txt.match(/(January|February|March|April|May|June|July|August|September|October|November|December)[^\d]*(20\d{2})/i);
    if (m) { const mi = monthIndexFromName(m[1]); if (mi !== null) return { monthIdx: mi, year: Number(m[2]) }; }
  }
  return null;
}

// Collect clickable day element handles + derived ISO
async function collectDayHandles(frame) {
  const out = [];

  // 1) ISO data-date
  for (const el of await frame.$$('[role="gridcell"][data-date], button[data-date]').catch(()=>[])) {
    const iso = await el.getAttribute("data-date");
    if (iso) out.push({ iso, handle: el });
  }
  if (out.length) return out;

  // 2) aria-label
  for (const el of await frame.$$('[role="gridcell"][aria-label], button[aria-label], [aria-label]').catch(()=>[])) {
    const label = await el.getAttribute("aria-label");
    const iso = parseISOFromAria(label || "");
    if (iso) out.push({ iso, handle: el });
  }
  if (out.length) return out;

  // 3) month header + numeric day
  const header = await getMonthHeader(frame);
  if (header) {
    for (const el of await frame.$$('[role="gridcell"], button, td').catch(()=>[])) {
      const txt = ((await el.textContent()) || "").trim();
      if (!/^\d{1,2}$/.test(txt)) continue;
      out.push({ iso: toISO(header.year, header.monthIdx, Number(txt)), handle: el });
    }
  }
  return out;
}

async function clickNext(frame) {
  const sels = [
    'button[aria-label="Next month"]',
    'button[title="Next"]',
    '[data-testid="next-month"]',
    'button:has-text("Next")'
  ];
  for (const s of sels) {
    const btn = await frame.$(s);
    if (btn) { try { await btn.click({ delay: 20 }); await frame.waitForTimeout(550); return true; } catch {} }
  }
  return false;
}

// Find times in a single frame (returns a Set of normalized strings)
async function timesInFrame(frame) {
  return frame.evaluate(() => {
    const found = new Set();
    const patterns = [
      /\b(?:[1-9]|1[0-2]):[0-5]\d\s?(?:am|pm)\b/gi, // 9:00 AM
      /\b(?:[1-9]|1[0-2])\s?(?:am|pm)\b/gi,         // 2 PM
      /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/gi            // 14:30
    ];
    // Scan common nodes
    const nodes = Array.from(document.querySelectorAll('button,a,[role="option"],[role="button"],li,div,span'));
    for (const n of nodes) {
      const t = (n.textContent || "").trim();
      if (!t) continue;
      for (const rx of patterns) {
        const m = t.match(rx);
        if (m) m.forEach(v => found.add(v.toLowerCase()));
      }
    }
    // Fallback: whole page text
    const whole = document.body?.innerText || "";
    for (const rx of patterns) {
      const m = whole.match(rx);
      if (m) m.forEach(v => found.add(v.toLowerCase()));
    }
    return Array.from(found);
  }).catch(()=>[]);
}

// Union times across all frames currently in the page
async function timesAcrossAllFrames(page) {
  const all = new Set();
  for (const f of page.frames()) {
    const list = await timesInFrame(f);
    for (const t of list) all.add(t);
  }
  return all;
}

// After clicking a day, poll for up to ~8s for times (they can render late)
async function waitForTimes(page, { attempts = 16, delayMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const set = await timesAcrossAllFrames(page);
    if (set.size) return set;
    await page.waitForTimeout(delayMs);
  }
  return new Set();
}

async function findEarliestDayWithSlots(page) {
  // Prefer the ChiliPiper/booking iframe; fall back to main
  const calFrame =
    page.frames().find(f => /chilipiper|calendar|widget|embed/i.test(f.url() || "")) ||
    page.mainFrame();

  await tryAcceptCookies(page);
  await tryAcceptCookies(calFrame);

  let monthsLeft = MAX_MONTHS;
  while (monthsLeft-- > 0) {
    const items = await collectDayHandles(calFrame);
    const uniq = Array.from(new Map(items.map(d => [d.iso, d])).values())
      .sort((a,b) => a.iso.localeCompare(b.iso));

    for (const d of uniq) {
      try {
        await d.handle.scrollIntoViewIfNeeded().catch(()=>{});
        await d.handle.click({ delay: 12, timeout: 2500 });
        // Let UI react
        await calFrame.waitForTimeout(300);
        // Poll all frames for times
        const times = await waitForTimes(page, { attempts: 16, delayMs: 500 });
        if (times.size >= MIN_SLOTS) {
          return { date: d.iso, slots: times.size };
        }
      } catch {
        // try next day
      }
    }

    const advanced = await clickNext(calFrame);
    if (!advanced) break;
  }
  return null;
}

// ---------- main ----------
(async ()=>{
  const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
  const context = await browser.newContext({
    timezoneId: TZ,
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  const page = await context.newPage();
  const results = [];

  for (const { name, url } of LINKS) {
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 90000 });
      await page.waitForTimeout(1000);

      const found = await findEarliestDayWithSlots(page);
      if (found) {
        results.push({
          name, url,
          earliestDate: found.date,
          daysFromToday: daysFromTodayISO(found.date),
          slotCountObserved: found.slots,
          scannedAt: new Date().toISOString()
        });
      } else {
        results.push({
          name, url,
          earliestDate: null,
          daysFromToday: null,
          slotCountObserved: 0,
          scannedAt: new Date().toISOString(),
          note: `No day with ≥${MIN_SLOTS} slots within ${MAX_MONTHS} months, or times rendered in an unsupported way.`
        });
      }
    } catch (e) {
      results.push({
        name, url,
        earliestDate: null,
        daysFromToday: null,
        slotCountObserved: 0,
        scannedAt: new Date().toISOString(),
        error: e?.message || String(e)
      });
    }
  }

  fs.writeFileSync(path.join(process.cwd(),"availability.json"), JSON.stringify(results, null, 2));
  await browser.close();
})().catch(e=>{ console.error(e); process.exit(1); });
