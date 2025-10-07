// Robust Playwright runner (CommonJS) that writes availability.json
// - Broader time-slot detection (HH:MM, H AM/PM, 24-hour, with/without minutes)
// - Handles cookie banners heuristically
// - Works whether ChiliPiper is in main frame or an iframe
// - Keeps your site 404-proof (workflow publishes a fallback JSON first)

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

function isTimeLike(text) {
  if (!text) return false;
  const t = text.trim();
  // Examples to match:
  // 9:00 AM, 09:00, 9am, 14:30, 2 PM, 2pm
  const withMinutes12 = /\b(?:[1-9]|1[0-2]):[0-5]\d\s?(?:am|pm)\b/i;
  const withMinutes24 = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/;
  const hourAmPm = /\b(?:[1-9]|1[0-2])\s?(?:am|pm)\b/i;
  return withMinutes12.test(t) || withMinutes24.test(t) || hourAmPm.test(t);
}

async function tryAcceptCookies(target) {
  // Click common consent buttons if present
  const labels = [/accept/i, /agree/i, /allow all/i, /got it/i, /ok/i];
  const candidates = await target.$$("button, [role=button]");
  for (const el of candidates) {
    const txt = (await el.textContent())?.trim() || "";
    if (labels.some(rx => rx.test(txt))) {
      try { await el.click({ timeout: 500 }); await target.waitForTimeout(300); } catch {}
    }
  }
}

async function getChiliFrame(page) {
  // Prefer iframe that includes 'chilipiper' in URL; fallback to main
  let frame = page.frames().find(f => (f.url() || "").includes("chilipiper"));
  return frame || page.mainFrame();
}

async function getVisibleDays(frame) {
  // Prefer ISO data-date attributes
  let days = await frame.$$eval('[role="gridcell"][data-date]', ns =>
    ns.map(n => n.getAttribute("data-date")).filter(Boolean)
  ).catch(()=>[]);
  if (days.length) return days.map(d => ({ iso: d, sel: `[role="gridcell"][data-date="${d}"]` }));

  // Fallback: buttons carrying data-date
  days = await frame.$$eval('button[data-date]', ns =>
    ns.map(n => n.getAttribute("data-date")).filter(Boolean)
  ).catch(()=>[]);
  if (days.length) return days.map(d => ({ iso: d, sel: `button[data-date="${d}"]` }));

  // Last-resort: mine any aria-label/data strings that contain YYYY-MM-DD
  const handles = await frame.$$('[role="gridcell"], button, [aria-label*="202"], [aria-label*="203"]').catch(()=>[]);
  const out = [];
  for (const h of handles || []) {
    let label = await h.getAttribute("data-date");
    if (!label) label = await h.getAttribute("aria-label");
    if (!label) continue;
    const m = label.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (m) out.push({ iso: m[1], sel: `[data-date="${m[1]}"], [aria-label*="${m[1]}"]` });
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
    const el = await frame.$(s);
    if (el) { try { await el.click({ delay: 20 }); await frame.waitForTimeout(600); return true; } catch {} }
  }
  return false;
}

async function countTimeSlots(frame) {
  // Try specific, then broader selectors
  const buckets = [
    // Common patterns
    '[data-testid*="time"][role="button"]',
    '[data-testid*="slot"]',
    '[role="listbox"] [role="option"]',
    '.time-slot button, .time-slot a',
    // Broad fallback
    'button, a, [role="option"], [role="button"]'
  ];
  for (const sel of buckets) {
    const items = await frame.$$(sel);
    if (!items.length) continue;
    let count = 0;
    for (const el of items) {
      const visible = await el.isVisible().catch(()=>false);
      if (!visible) continue;
      const txt = ((await el.textContent()) || "").trim();
      if (isTimeLike(txt)) count++;
    }
    if (count) return count;
  }
  return 0;
}

async function findEarliestDayWithSlots(page) {
  const frame = await getChiliFrame(page);
  await tryAcceptCookies(frame); // handle consent if present

  let monthsLeft = MAX_MONTHS;
  while (monthsLeft-- > 0) {
    const days = await getVisibleDays(frame);
    for (const d of days) {
      const el = await frame.$(d.sel);
      if (!el) continue;
      try {
        await el.scrollIntoViewIfNeeded().catch(()=>{});
        await el.click({ delay: 10, timeout: 3000 });
        // Allow time list to render
        await frame.waitForTimeout(600);
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
    // Realistic UA to avoid headless-specific styling
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  const results = [];
  for (const { name, url } of LINKS) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      // Give embeds/iframes time to mount
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
          note: `No day with ≥${MIN_SLOTS} within ${MAX_MONTHS} months (or slots not detectable).`
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
