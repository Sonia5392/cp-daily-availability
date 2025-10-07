// CommonJS Playwright runner that writes availability.json (no Slack, no CSV)

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

async function findChiliFrame(page){
  return page.frames().find(f => (f.url() || "").includes("chilipiper")) || page.mainFrame();
}
async function countTimeSlots(frame){
  return frame.$$eval("button, a", nodes =>
    nodes.filter(n => {
      const t=(n.textContent||"").trim();
      const v=(n.offsetWidth||n.offsetHeight||n.getClientRects().length)>0;
      return v && /(^|\s)\d{1,2}:\d{2}\s*(am|pm)?$/i.test(t);
    }).length
  );
}
async function getVisibleDays(frame){
  let days = await frame.$$eval('[role="gridcell"][data-date]', ns => ns.map(n => n.getAttribute("data-date")).filter(Boolean)).catch(()=>[]);
  if (days.length) return days.map(d => ({ iso:d, sel:`[role="gridcell"][data-date="${d}"]` }));

  days = await frame.$$eval('button[data-date]', ns => ns.map(n => n.getAttribute("data-date")).filter(Boolean)).catch(()=>[]);
  if (days.length) return days.map(d => ({ iso:d, sel:`button[data-date="${d}"]` }));

  const hs = await frame.$$('[role="gridcell"], button[aria-label*="202"], button[aria-label*="203"]').catch(()=>[]);
  const out=[];
  for (const h of hs||[]){
    const dataDate = await h.getAttribute("data-date");
    const label = dataDate || (await h.getAttribute("aria-label")) || "";
    const m = label.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (m) out.push({ iso:m[1], sel:`[data-date="${m[1]}"], [aria-label*="${m[1]}"]` });
  }
  return out;
}
async function clickNext(frame){
  for (const s of ['button[aria-label="Next month"]','button[title="Next"]','[data-testid="next-month"]','button:has-text("Next")']){
    const el = await frame.$(s); if (el){ await el.click({delay:20}); await frame.waitForTimeout(600); return true; }
  }
  return false;
}
async function findEarliestDayWithSlots(page){
  const frame = await findChiliFrame(page);
  let monthsLeft = MAX_MONTHS;
  while (monthsLeft-- > 0){
    const days = await getVisibleDays(frame);
    for (const d of days){
      const el = await frame.$(d.sel); if (!el) continue;
      await el.click({delay:10});
      await frame.waitForTimeout(450);
      const c = await countTimeSlots(frame);
      if (c >= MIN_SLOTS) return { date:d.iso, slots:c };
    }
    if (!await clickNext(frame)) break;
  }
  return null;
}

(async ()=>{
  const browser = await chromium.launch({ headless:true });
  const context = await browser.newContext({ timezoneId: TZ, locale:"en-US" });
  const page = await context.newPage();

  const results=[];
  for (const {name,url} of LINKS){
    try{
      await page.goto(url, { waitUntil:"domcontentloaded", timeout:60000 });
      await page.waitForTimeout(1500);
      const found = await findEarliestDayWithSlots(page);
      if (found){
        results.push({
          name,url,
          earliestDate: found.date,
          daysFromToday: daysFromTodayISO(found.date),
          slotCountObserved: found.slots,
          scannedAt: new Date().toISOString()
        });
      }else{
        results.push({
          name,url,
          earliestDate: null,
          daysFromToday: null,
          slotCountObserved: 0,
          scannedAt: new Date().toISOString(),
          note: `No day with ≥${MIN_SLOTS} within ${MAX_MONTHS} months`
        });
      }
    }catch(e){
      results.push({
        name,url,
        earliestDate: null, daysFromToday: null, slotCountObserved: 0,
        scannedAt: new Date().toISOString(),
        error: e?.message || String(e)
      });
    }
  }

  fs.writeFileSync(path.join(process.cwd(),"availability.json"), JSON.stringify(results,null,2));
  await browser.close();
})().catch(e=>{ console.error(e); process.exit(1); });
