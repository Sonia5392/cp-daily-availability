// Robust ChiliPiper checker (CommonJS). No Slack/CSV.
// Fixes "Not Found" by:
// - deriving ISO dates from aria-label or month header + day number
// - broad time-slot detection (9:00 AM, 9am, 2 PM, 14:30, etc.)
// - better iframe targeting and render waits

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// Load config
const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), "links.json"), "utf8"));
const TZ = process.env.TZ || config.timezone || "America/New_York";
const MIN_SLOTS = Number(config.minSlots || 3);
const MAX_MONTHS = Number(config.maxMonthsToScan || 6);
const LINKS = config.links || [];

// Helpers
function midnight(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
function daysFromTodayISO(iso){ return Math.round((midnight(iso)-midnight(new Date()))/86400000); }

function monthIndexFromName(name) {
  const m = name.toLowerCase();
  const list = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const i = list.findIndex(n => m.startsWith(n));
  return i >= 0 ? i : null;
}

function toISO(y, mIdx, day) {
  const yyyy = String(y);
  const mm = String(mIdx + 1).padStart(2, "0");
  const dd = String(day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function parseISOFromAria(label) {
  if (!label) return null;
  // Try direct ISO
  let m = label.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (m) return m[1];
  // Try "Friday, October 17, 2025" or "October 2025 17"
  m = label.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})/i);
  if (m) {
    const mi = monthIndexFromName(m[1]);
    if (mi !== null) return toISO(Number(m[3]), mi, Number(m[2]));
  }
  return null;
}

function isTimeLike(t) {
  if (!t) return false;
  const s = t.trim();
  return (
    /\b(?:[1-9]|1[0-2]):[0-5]\d\s?(?:am|pm)\b/i.test(s) || // 9:00 AM
    /\b(?:[1-9]|1[0-2])\s?(?:am|pm)\b/i.test(s) ||         // 2 PM
    /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(s)               // 14:30
  );
}

async function tryAcceptCookies(target) {
  const labels = [/accept/i, /agree/i, /allow all/i, /got it/i, /^ok$/i];
  const candidates = await target.$$("button, [role=button]");
  for (const el of candidates) {
    const txt = (await el.textContent())?.trim() || "";
    if (labels.some(rx => rx.test(txt))) {
      try { await el.click({ timeout: 400 }); await target.waitForTimeout(250); } catch {}
    }
  }
}

async function getCalendarHeader(frame) {
  // Try common month-year captions (role=heading/aria-live etc.)
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
    if (m) {
      const mi = monthIndexFromName(m[1]);
      if (mi !== null) return { monthIdx: mi, year: Number(m[2]) };
    }
  }
  return null;
}

async function getVisibleDays(frame) {
  // 1) Direct ISO data-date
  let days = await frame.$$eval('[role="gridcell"][data-date]', ns =>
    ns.map(n => n.getAttribute("data-date")).filter(Boolean)
  ).catch(()=>[]);
  if (days.length) {
    return days.map(d => ({ iso: d, sel: `[role="gridcell"][data-date="${d}"]` }));
  }

  // 2) Buttons with data-date
  days = await frame.$$eval('button[data-date]', ns =>
    ns.map(n => n.getAttribute("data-date")).filter(Boolean)
  ).catch(()=>[]);
  if (days.length) {
    return days.map(d => ({ iso: d, sel: `button[data-date="${d}"]` }));
  }

  // 3) aria-label parsing to ISO
  const elems = await frame.$$('[role="gridcell"], button[aria-label], [aria-label]').catch(()=>[]);
  const viaAria = [];
  for (const el of elems || []) {
    const label = await el.getAttribute("aria-label");
    const iso = parseISOFromAria(label || "");
    if (iso) viaAria.push({ iso, sel: `[aria-label="${label}"]` });
  }
  if (viaAria.length) return viaAria;

  // 4) Last resort: get month/year from header and pair with numeric day text
  const header = await getCalendarHeader(frame);
  if (header) {
    const cells = await frame.$$('[role="gridcell"], button, td').catch(()=>[]);
    const out = [];
    for (const el of cells || []) {
      const txt = ((await el.textContent()) || "").trim();
      if (!/^\d{1,2}$/.test(txt)) continue; // day number like "17"
      const iso = toISO(header.year, header.monthIdx, Number(txt));
      out.push({ iso, sel: `:scope >> text="${txt}"` });
    }
    if (out.length) return out;
  }

  return [];
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
    if (btn) {
      try { await btn.click({ delay: 20 }); await frame.waitForTimeout(550); return true; } catch {}
    }
  }
  return false;
}

async function countTimeSlots(frame) {
  // Try specific selectors first, then broad scan with isTimeLike
  const candidateSets = [
    '[data-testid*="time"][role="button"]',
    '[data-testid*="slot"]',
    '[role="listbox"] [role="option"]',
    '.time-slot button, .time-slot a',
    'button, a, [role="option"], [role="button"]'
  ];
  for (const sel of candidateSets) {
    const els = await frame.$$(sel);
    if (!els.length) continue;
    let ct = 0;
    for (const el of els) {
      const visible = await el.isVisible().catch(()=>false);
      if (!visible) continue;
      const txt = ((await el.textContent()) || "").trim();
      if (isTimeLike(txt)) ct++;
    }
    if (ct) return ct;
  }
  return 0;
}

async function findEarliestDayWithSlots(page) {
  // Find the most relevant iframe; fallback to main frame
  const frame =
    page.frames().find(f => (f.url() || "").includes("chilipiper")) ||
    page.mainFrame();

  await tryAcceptCookies(frame);

  let monthsLeft = MAX_MONTHS;
  while (monthsLeft-- > 0) {
    const days = await getVisibleDays(frame);
    // Sort unique days ascending by ISO, to avoid duplicates from different selectors
    const uniq = Array.from(new Map(days.map(d => [d.iso, d])).values())
      .sort((a,b) => a.iso.localeCompare(b.iso));

    for (const d of uniq) {
      const el = await frame.$(d.sel).catch(()=>null);
      if (!el) continue;
      try {
        await el.scrollIntoViewIfNeeded().catch(()=>{});
        await el.click({ delay: 12, timeout: 2500 });
        await frame.waitForTimeout(650); // let times render
      } catch { continue; }

      const slots = await countTimeSlots(frame);
      if (slots >= MIN_SLOTS) return { date: d.iso, slots };
    }

    const advanced = await clickNext(frame);
    if (!advanced) break;
  }
  return null;
}

(async ()=>{
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    timezoneId: TZ,
    locale: "en-US",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  const results = [];
  for (const { name, url } of LINKS) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1200);
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
          note: `No day with ≥${MIN_SLOTS} slots within ${MAX_MONTHS} months, or times not detectable.`
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

  fs.writeFileSync(path.join(process.cwd(), "availability.json"), JSON.stringify(results, null, 2));
  await browser.close();
})().catch(e=>{ console.error(e); process.exit(1); });
