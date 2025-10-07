// ChiliPiper checker (CommonJS) — scans ALL frames, logs network, writes availability.json
// No Slack/CSV. Designed for GitHub Actions + GitHub Pages.

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// Config
const cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "links.json"), "utf8"));
const TZ = process.env.TZ || cfg.timezone || "America/New_York";
const MIN_SLOTS = Number(cfg.minSlots || 3);
const MAX_MONTHS = Number(cfg.maxMonthsToScan || 6);
const LINKS = cfg.links || [];

// Helpers
function midnight(d){ const x=new Date(d); x.setHours(0,0,0,0); return x; }
function daysFromTodayISO(iso){ return Math.round((midnight(iso)-midnight(new Date()))/86400000); }
function monthIndexFromName(name){ const m=(name||"").toLowerCase(); const list=["january","february","march","april","may","june","july","august","september","october","november","december"]; const i=list.findIndex(n=>m.startsWith(n)); return i>=0?i:null; }
function toISO(y, mIdx, day){ return `${y}-${String(mIdx+1).padStart(2,"0")}-${String(day).padStart(2,"0")}`; }
function parseISOFromAria(label){
  if (!label) return null;
  let m = label.match(/\b(20\d{2}-\d{2}-\d{2})\b/); if (m) return m[1];
  m = label.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(20\d{2})/i);
  if (m){ const mi=monthIndexFromName(m[1]); if (mi!==null) return toISO(Number(m[3]), mi, Number(m[2])); }
  return null;
}
async function tryAcceptCookies(target){
  const labels=[/accept/i,/agree/i,/allow all/i,/got it/i,/^ok$/i];
  const els = await target.$$("button, [role=button]").catch(()=>[]);
  for (const el of els||[]){
    const t=(await el.textContent())?.trim()||"";
    if (labels.some(rx=>rx.test(t))){ try{ await el.click({timeout:500}); await target.waitForTimeout(250);}catch{} }
  }
}
async function getMonthHeader(frame){
  const sels=['[aria-live="polite"]','[data-testid*="current-month"]','.DayPicker-Caption','.react-datepicker__current-month','header h2, h2'];
  for (const s of sels){
    const el=await frame.$(s); if (!el) continue;
    const txt=(await el.textContent())?.trim()||"";
    const m=txt.match(/(January|February|March|April|May|June|July|August|September|October|November|December)[^\d]*(20\d{2})/i);
    if (m){ const mi=monthIndexFromName(m[1]); if (mi!==null) return {monthIdx:mi, year:Number(m[2])}; }
  }
  return null;
}
// Collect clickable day handles + ISO date for current view
async function collectDayHandles(frame){
  const out=[];
  for (const el of await frame.$$('[role="gridcell"][data-date], button[data-date]').catch(()=>[])){
    const iso=await el.getAttribute("data-date"); if (iso) out.push({ iso, handle: el });
  }
  if (out.length) return out;
  for (const el of await frame.$$('[role="gridcell"][aria-label], button[aria-label], [aria-label]').catch(()=>[])){
    const label=await el.getAttribute("aria-label"); const iso=parseISOFromAria(label||""); if (iso) out.push({ iso, handle: el });
  }
  if (out.length) return out;
  const head=await getMonthHeader(frame);
  if (head){
    for (const el of await frame.$$('[role="gridcell"], button, td').catch(()=>[])){
      const txt=((await el.textContent())||"").trim();
      if (!/^\d{1,2}$/.test(txt)) continue;
      out.push({ iso: toISO(head.year, head.monthIdx, Number(txt)), handle: el });
    }
  }
  return out;
}
async function clickNext(frame){
  const sels=['button[aria-label="Next month"]','button[title="Next"]','[data-testid="next-month"]','button:has-text("Next")'];
  for (const s of sels){ const btn=await frame.$(s); if (btn){ try{ await btn.click({delay:20}); await frame.waitForTimeout(550); return true;}catch{} } }
  return false;
}
// Extract times from a frame
async function timesInFrame(frame){
  return frame.evaluate(()=>{
    const found=new Set();
    const rex=[/\b(?:[1-9]|1[0-2]):[0-5]\d\s?(?:am|pm)\b/gi, /\b(?:[1-9]|1[0-2])\s?(?:am|pm)\b/gi, /\b(?:[01]?\d|2[0-3]):[0-5]\d\b/gi];
    const nodes=[...document.querySelectorAll('button,a,[role="option"],[role="button"],li,div,span')];
    for (const n of nodes){
      const t=(n.textContent||"").trim(); if (!t) continue;
      for (const r of rex){ const m=t.match(r); if (m) m.forEach(v=>found.add(v.toLowerCase())); }
    }
    const whole=document.body?.innerText||"";
    for (const r of rex){ const m=whole.match(r); if (m) m.forEach(v=>found.add(v.toLowerCase())); }
    return Array.from(found);
  }).catch(()=>[]);
}
async function timesAcrossAllFrames(page){
  const all=new Set();
  for (const f of page.frames()){ const list=await timesInFrame(f); for (const t of list) all.add(t); }
  return all;
}
async function waitForTimes(page,{attempts=18,delayMs=450}={}){
  for (let i=0;i<attempts;i++){ const s=await timesAcrossAllFrames(page); if (s.size) return s; await page.waitForTimeout(delayMs); }
  return new Set();
}
async function findEarliestDayWithSlots(page, debug){
  // Prefer ChiliPiper/calendar iframe, fall back to main
  const calFrame = page.frames().find(f => /chilipiper|calendar|widget|embed/i.test(f.url()||"")) || page.mainFrame();
  await tryAcceptCookies(page); await tryAcceptCookies(calFrame);

  let monthsLeft=MAX_MONTHS;
  while (monthsLeft-- > 0){
    const items=await collectDayHandles(calFrame);
    const uniq=Array.from(new Map(items.map(d=>[d.iso,d])).values()).sort((a,b)=>a.iso.localeCompare(b.iso));

    for (const d of uniq){
      try{
        await d.handle.scrollIntoViewIfNeeded().catch(()=>{});
        await d.handle.click({delay:12, timeout:2500});
        await calFrame.waitForTimeout(350);
        const times=await waitForTimes(page,{attempts:18,delayMs:450});
        if (debug) debug.lastTimes = Array.from(times);
        if (times.size >= MIN_SLOTS) return { date:d.iso, slots: times.size };
      }catch{/* try next day */}
    }
    const advanced=await clickNext(calFrame);
    if (!advanced) break;
  }
  return null;
}

(async()=>{
  // Use Chrome channel (closer to real Chrome)
 const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"]
});

  const context = await browser.newContext({
    timezoneId: TZ,
    locale: "en-US",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    recordHar: { path: "debug/network.har", content: "embed" }
  });
  await context.addInitScript(()=>{ Object.defineProperty(navigator,"webdriver",{get:()=>undefined}); });

  const page = await context.newPage();
  const net = [];
  page.on("response", async (res)=>{
    const url=res.url(); const status=res.status();
    if (/chilipiper|zoominfo|calendar|slot|time/i.test(url) || status>=400){
      net.push({ url, status, type: res.request().resourceType(), ts: new Date().toISOString() });
    }
  });

  const results=[];
  for (const {name,url} of LINKS){
    const debugInfo={ name, url, frames: [] };
    try{
      await page.goto(url, { waitUntil:"networkidle", timeout: 90000 });
      await page.waitForTimeout(800);

      // Frame map (for debugging)
      debugInfo.frames = page.frames().map(f => ({ name: f.name(), url: f.url() }));
      const found = await findEarliestDayWithSlots(page, debugInfo);

      if (found){
        results.push({ name, url, earliestDate:found.date, daysFromToday:daysFromTodayISO(found.date), slotCountObserved:found.slots, scannedAt:new Date().toISOString() });
      } else {
        results.push({ name, url, earliestDate:null, daysFromToday:null, slotCountObserved:0, scannedAt:new Date().toISOString(), note: `No day with ≥${MIN_SLOTS} slots within ${MAX_MONTHS} months.` });
      }
    }catch(e){
      results.push({ name, url, earliestDate:null, daysFromToday:null, slotCountObserved:0, scannedAt:new Date().toISOString(), error: e?.message || String(e) });
    }finally{
      // Persist debug artifacts
      try{
        fs.mkdirSync("debug", { recursive: true });
        fs.writeFileSync(path.join("debug", `${name.replace(/[^a-z0-9\-_.]+/gi,"_")}.frames.json`), JSON.stringify(debugInfo, null, 2));
        fs.writeFileSync(path.join("debug", "network.log.json"), JSON.stringify(net, null, 2));
        await page.screenshot({ path: path.join("debug", `${name.replace(/[^a-z0-9\-_.]+/gi,"_")}.png`), fullPage: true });
        const mainHtml = await page.evaluate(()=>document.documentElement.outerHTML).catch(()=>null);
        if (mainHtml) fs.writeFileSync(path.join("debug", `${name.replace(/[^a-z0-9\-_.]+/gi,"_")}.html`), mainHtml);
      }catch{}
    }
  }

  fs.writeFileSync(path.join(process.cwd(),"availability.json"), JSON.stringify(results, null, 2));
  await browser.close();
})().catch(e=>{ console.error(e); process.exit(1); });
