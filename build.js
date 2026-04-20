// ============================================================
// KRB Rental Matrix Dashboard — Netlify Build Script
// Fetches live data from Notion, writes public/index.html
// Node.js 18+ required (uses built-in fetch)
// ============================================================
'use strict';

const fs = require('fs');

// ── Config ─────────────────────────────────────────────────
const NOTION_TOKEN = process.env.NOTION_TOKEN;

// Database IDs
const DB = {
  rentalMatrix: '2d161a46-cdef-80a8-aae1-cf5bb3f0fb0b',
  weeklyKPI:    '2d561a46-cdef-803f-98fa-f0a23380931e',
  monthlyKPI:   '2d261a46-cdef-802d-b84c-d420aa2f8d47',
  dwor:         '39757054-7d11-47f6-9a02-fe930edf035e',
  ownerMatrix:  '2f161a46-cdef-809f-9ae0-f17fbdc7d0a6',
};

if (!NOTION_TOKEN) {
  console.error('ERROR: NOTION_TOKEN environment variable is not set.');
  process.exit(1);
}

// ── Notion API: fetch ALL pages from a database ────────────
async function queryAllPages(databaseId, filter = null) {
  const pages  = [];
  let cursor   = null;
  let hasMore  = true;
  const headers = {
    'Authorization':  `Bearer ${NOTION_TOKEN}`,
    'Notion-Version': '2022-06-28',
    'Content-Type':   'application/json',
  };

  while (hasMore) {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    if (filter) body.filter = filter;

    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method:  'POST',
      headers,
      body:    JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Notion API error ${res.status}: ${text}`);
    }

    const data = await res.json();
    pages.push(...data.results);
    hasMore = data.has_more;
    cursor  = data.next_cursor;

    if (hasMore) await new Promise(r => setTimeout(r, 200)); // rate-limit buffer
  }

  return pages;
}

// ── Property value extractors ────────────────────────────────
const P = {
  title:    p => p?.title?.[0]?.plain_text?.trim()    || '',
  text:     p => p?.rich_text?.[0]?.plain_text?.trim() || '',
  select:   p => p?.select?.name  || null,
  checkbox: p => p?.checkbox      ?? false,
  number:   p => p?.number        ?? null,
  date:     p => p?.date?.start   || null,
  relation: p => p?.relation      || [],
  formula:  p => {
    const f = p?.formula;
    if (!f) return null;
    if (f.type === 'number')  return f.number;
    if (f.type === 'string')  return f.string;
    if (f.type === 'boolean') return f.boolean;
    return null;
  },
};

// Shorthand: get property from a Notion page
const g = (page, key, type = 'select') => P[type](page.properties?.[key]);

// ── Main ─────────────────────────────────────────────────────
async function build() {
  console.log('[1/6] Fetching Rental Matrix from Notion…');
  const rentalPages = await queryAllPages(DB.rentalMatrix);
  console.log(`      → ${rentalPages.length} records`);

  console.log('[2/6] Fetching Weekly KPI from Notion…');
  const weeklyPages = await queryAllPages(DB.weeklyKPI);
  console.log(`      → ${weeklyPages.length} records`);

  console.log('[3/6] Fetching Monthly KPI from Notion…');
  const monthlyPages = await queryAllPages(DB.monthlyKPI);
  console.log(`      → ${monthlyPages.length} records`);

  console.log('[4/6] Fetching DWOR from Notion…');
  const dworPages = await queryAllPages(DB.dwor);
  console.log(`      → ${dworPages.length} records`);

  console.log('[5/6] Fetching Owner Matrix from Notion…');
  const ownerPages = await queryAllPages(DB.ownerMatrix);
  console.log(`      → ${ownerPages.length} records`);

  console.log('[6/6] Computing metrics…');
  const D = computeMetrics(rentalPages, weeklyPages, monthlyPages, dworPages, ownerPages);

  fs.mkdirSync('public', { recursive: true });
  fs.writeFileSync('public/index.html', generateHTML(D), 'utf8');
  console.log(`✅  Dashboard built → public/index.html  (${D.meta.updatedAt})`);
}

// ── Metric computation ────────────────────────────────────────
function computeMetrics(rentalPages, weeklyPages, monthlyPages, dworPages, ownerPages) {

  // ── Rental Matrix ─────────────────────────────────────────
  // Field names in Notion Rental Matrix
  const activeProps = rentalPages.filter(p => {
    const code   = g(p, 'Property Code', 'title');
    const active = g(p, 'Active Property', 'select');
    return active === 'ACTIVE' && code !== 'KRB-01';
  });

  const revProps = activeProps.filter(p => g(p, 'Revenue', 'checkbox') === true);
  const occupied = revProps.filter(p => g(p, 'Occupied Flag', 'formula') === true);

  const totalDoors    = activeProps.length;
  const availToRent   = revProps.length;
  const occupiedCt    = occupied.length;
  const occupancyRate = +((occupiedCt / availToRent) * 100).toFixed(1);

  // Rental Status breakdown (all revenue props)
  const rentalStatus = tally(revProps, p => g(p, 'Rental Status', 'select') || 'No Status');

  // Breakdowns (active props)
  const cities   = tally(activeProps, p => g(p, 'City', 'select') || 'Unknown');
  const propTypes= tally(activeProps, p => g(p, 'Property Type', 'select') || 'Unknown');
  const bedrooms = tally(activeProps, p => {
    const b = g(p, 'Bedrooms', 'select');
    return b ? b + ' BR' : null;
  }, true);
  const hoa  = tally(activeProps, p => g(p, 'HOA', 'select') || 'Not Specified');
  const hvac = tally(activeProps, p => g(p, 'HVAC PM', 'select') || 'Not Enrolled');
  const pool = tally(activeProps, p => g(p, 'Pool/Hot Tub', 'select') || 'Not Listed');

  // Mgmt Fee % (number field; value is decimal e.g. 0.09 = 9%)
  const mgmtFees = tally(revProps, p => {
    const v = g(p, 'Mgmt Fee %', 'number');
    if (v == null) return null;
    // Handle both 0.09 and 9 storage formats
    const pct = v > 1 ? Math.round(v) : Math.round(v * 100);
    return pct + '%';
  }, true);

  // Year built buckets (active)
  const yb = { 'Pre-1970':0,'1970s':0,'1980s':0,'1990s':0,'2000s':0,'2010s':0,'2020+':0 };
  activeProps.forEach(p => {
    const y = g(p, 'Year Built', 'number');
    if (!y) return;
    if      (y < 1970) yb['Pre-1970']++;
    else if (y < 1980) yb['1970s']++;
    else if (y < 1990) yb['1980s']++;
    else if (y < 2000) yb['1990s']++;
    else if (y < 2010) yb['2000s']++;
    else if (y < 2020) yb['2010s']++;
    else               yb['2020+']++;
  });
  const yearBuilt = Object.entries(yb);

  // Rent stats (occupied)
  const rents   = occupied.map(p => g(p, 'Current Rent', 'number')).filter(v => v > 0);
  const avgRent = rents.length ? Math.round(rents.reduce((a,b)=>a+b,0)/rents.length) : 0;
  const minRent = rents.length ? Math.min(...rents) : 0;
  const maxRent = rents.length ? Math.max(...rents) : 0;

  // Avg rent by city & bedrooms (occupied)
  const avgRentCity = avgGroup(occupied, p => g(p,'City','select'), p => g(p,'Current Rent','number'));
  const avgRentBeds = avgGroup(occupied, p => {
    const b = g(p,'Bedrooms','select'); return b ? b+' BR' : null;
  }, p => g(p,'Current Rent','number'));

  // Top 15 by rent (active)
  const topProps = [...activeProps]
    .filter(p => g(p,'Current Rent','number') > 0)
    .sort((a,b) => g(b,'Current Rent','number') - g(a,'Current Rent','number'))
    .slice(0, 15)
    .map(p => ({
      a:  g(p,'Street Address - Property','text') || g(p,'Street Address','text') || '—',
      c:  g(p,'City','select') || '—',
      t:  g(p,'Property Type','select') || '—',
      b:  g(p,'Bedrooms','select') || '—',
      ba: g(p,'Bathrooms','select') || '—',
      r:  g(p,'Current Rent','number'),
      s:  g(p,'Rental Status','select') || 'Unknown',
    }));

  // ── Weekly KPI ────────────────────────────────────────────
  const weekly = weeklyPages
    .filter(p => g(p,'Date','date'))
    .sort((a,b) => new Date(g(b,'Date','date')) - new Date(g(a,'Date','date')));

  const now           = new Date();
  const sixMonthsAgo  = new Date(now); sixMonthsAgo.setMonth(now.getMonth()-6);
  const thirteenWkAgo = new Date(now); thirteenWkAgo.setDate(now.getDate()-91);

  // Speed & Turnover: bucket by month, average, last 6 months
  const speedBuckets = {}, turnBuckets = {};
  weekly.forEach(p => {
    const d = new Date(g(p,'Date','date'));
    if (d < sixMonthsAgo) return;
    const mk  = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const lbl = d.toLocaleString('en-US',{month:'long',year:'numeric'});
    const spd = g(p,'Speed to Repair','number');
    const trn = g(p,'Turnover Time','number');
    if (spd != null) {
      speedBuckets[mk] = speedBuckets[mk] || {sum:0,n:0,lbl};
      speedBuckets[mk].sum += spd; speedBuckets[mk].n++;
    }
    if (trn != null) {
      turnBuckets[mk] = turnBuckets[mk] || {sum:0,n:0,lbl};
      turnBuckets[mk].sum += trn; turnBuckets[mk].n++;
    }
  });

  const speedKeys   = Object.keys(speedBuckets).sort();
  const speedLabels = speedKeys.map(k => speedBuckets[k].lbl);
  const speedVals   = speedKeys.map(k => +(speedBuckets[k].sum/speedBuckets[k].n).toFixed(1));
  const turnKeys    = Object.keys(turnBuckets).sort();
  const turnLabels  = turnKeys.map(k => turnBuckets[k].lbl);
  const turnVals    = turnKeys.map(k => +(turnBuckets[k].sum/turnBuckets[k].n).toFixed(1));

  // Open WOs: last 13 weeks (oldest→newest)
  const openRecs   = weekly.filter(p => new Date(g(p,'Date','date')) >= thirteenWkAgo).reverse();
  const openLabels = openRecs.map(p => {
    const d = new Date(g(p,'Date','date'));
    return `${d.getMonth()+1}/${d.getDate()}`;
  });
  const openVals = openRecs.map(p => g(p,'Total Open','number') || 0);

  // Latest week values
  const lw             = weekly[0]?.properties || {};
  const latestSpeed    = speedVals[speedVals.length-1] || 0;
  const latestTurn     = turnVals[turnVals.length-1]   || 0;
  const latestSpeedLbl = speedLabels[speedLabels.length-1] || '';
  const latestTurnLbl  = turnLabels[turnLabels.length-1]   || '';
  const latestOpenWO   = openVals[openVals.length-1] || 0;
  const latestOpenDate = openLabels[openLabels.length-1] || '';
  const latestDOM      = P.number(lw['Days on Market (Filtered)']) || 0;

  // Sales CR: stored as a number (0–100 or 0–1, check both)
  const rawCR   = P.number(lw['Sales CR']) ?? P.formula(lw['Sales CR']);
  const salesCR = rawCR != null ? (rawCR > 1 ? +rawCR.toFixed(1) : +(rawCR*100).toFixed(1)) : null;

  const latestWeekDate = g(weekly[0], 'Date', 'date')
    ? new Date(g(weekly[0],'Date','date')).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})
    : '';

  // ── Monthly KPI ───────────────────────────────────────────
  const monthly = monthlyPages
    .filter(p => g(p,'Date','date'))
    .sort((a,b) => new Date(g(a,'Date','date')) - new Date(g(b,'Date','date')));

  const twelveMonthsAgo = new Date(now); twelveMonthsAgo.setFullYear(now.getFullYear()-1);
  const recentMonthly   = monthly.filter(p => new Date(g(p,'Date','date')) >= twelveMonthsAgo);

  const renewalLabels=[], renewalVals=[], revLabels=[], revVals=[], doorVals=[];
  recentMonthly.forEach(p => {
    const d   = new Date(g(p,'Date','date'));
    const lbl = d.toLocaleString('en-US',{month:'short',year:'2-digit'});
    renewalLabels.push(lbl);
    const exp = g(p,'Lease Expirations','number') || 0;
    const ren = g(p,'Renewed Leases','number')    || 0;
    renewalVals.push(exp > 0 ? +((ren/exp)*100).toFixed(1) : 0);
    revLabels.push(lbl);
    revVals.push(g(p,'Revenue','number') || 0);
    doorVals.push(g(p,'Filtered Door Count','number') || 0);
  });

  const lastRenewalRate = renewalVals[renewalVals.length-1] || 0;
  const avgRenewalRate  = renewalVals.length ? +(renewalVals.reduce((a,b)=>a+b,0)/renewalVals.length).toFixed(1) : 0;
  const lastRenewalLbl  = renewalLabels[renewalLabels.length-1] || '';
  const firstRenewalLbl = renewalLabels[0] || '';

  // ── DWOR ─────────────────────────────────────────────────
  const makeReadys = dworPages.filter(p => g(p, 'DWOR Type', 'select') === 'Make Ready');
  const turnovers  = dworPages.filter(p => g(p, 'DWOR Type', 'select') === 'Turnover');

  const mrDays  = makeReadys.map(p => g(p, 'DWOR', 'number')).filter(v => v > 0);
  const trnDays = turnovers .map(p => g(p, 'DWOR', 'number')).filter(v => v > 0);
  const avgMRDays  = mrDays.length  ? +(mrDays.reduce((a,b)=>a+b,0)/mrDays.length).toFixed(1)   : 0;
  const avgTrnDays = trnDays.length ? +(trnDays.reduce((a,b)=>a+b,0)/trnDays.length).toFixed(1) : 0;

  // Monthly trend: Make Ready vs Turnover counts, last 6 months
  const dworBuckets = {};
  const sixMoAgoD = new Date(now); sixMoAgoD.setMonth(now.getMonth()-6);
  dworPages.forEach(p => {
    const startDate = g(p, 'DWOR Start', 'date');
    if (!startDate) return;
    const d = new Date(startDate);
    if (d < sixMoAgoD) return;
    const mk  = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const lbl = d.toLocaleString('en-US', {month:'short', year:'2-digit'});
    const type = g(p, 'DWOR Type', 'select') || 'Unknown';
    dworBuckets[mk] = dworBuckets[mk] || {lbl, mr:0, trn:0};
    if (type === 'Make Ready') dworBuckets[mk].mr++;
    else if (type === 'Turnover') dworBuckets[mk].trn++;
  });
  const dworKeys   = Object.keys(dworBuckets).sort();
  const dworLabels = dworKeys.map(k => dworBuckets[k].lbl);
  const dworMR     = dworKeys.map(k => dworBuckets[k].mr);
  const dworTrn    = dworKeys.map(k => dworBuckets[k].trn);

  // ── Owner Matrix ──────────────────────────────────────────
  const activeOwners   = ownerPages.filter(p => g(p, 'ACTIVE', 'select') === 'ACTIVE');
  const inactiveOwners = ownerPages.filter(p => g(p, 'ACTIVE', 'select') !== 'ACTIVE');
  const totalOwners    = activeOwners.length;

  // Distribution by SF Rentals count
  const ownerDist = {'1 Property':0, '2–3 Properties':0, '4–5 Properties':0, '6+ Properties':0};
  activeOwners.forEach(p => {
    const sf = g(p, 'SF Rentals', 'number') || 0;
    if      (sf <= 1) ownerDist['1 Property']++;
    else if (sf <= 3) ownerDist['2–3 Properties']++;
    else if (sf <= 5) ownerDist['4–5 Properties']++;
    else              ownerDist['6+ Properties']++;
  });

  // ── Timestamp ─────────────────────────────────────────────
  const updatedAt = new Date().toLocaleString('en-US',{
    timeZone:'America/Boise',
    month:'short',day:'numeric',year:'numeric',
    hour:'2-digit',minute:'2-digit',
  }) + ' MT';

  return {
    kpis:{ totalDoors, availToRent, occupied:occupiedCt, occupancyRate, avgRent, minRent, maxRent },
    rentalStatus, cities, propTypes, bedrooms, mgmtFees, hoa, hvac, pool,
    yearBuilt, avgRentCity, avgRentBeds, topProps,
    renewalLabels, renewalVals, revLabels, revVals, doorVals,
    speedLabels, speedVals, turnLabels, turnVals, openLabels, openVals,
    dworLabels, dworMR, dworTrn, ownerDist,
    owners:{ totalOwners, inactiveOwners: inactiveOwners.length, avgMRDays, avgTrnDays, makeReadyCt: makeReadys.length, turnoverCt: turnovers.length },
    meta:{
      latestSpeed, latestTurn, latestSpeedLbl, latestTurnLbl,
      latestOpenWO, latestOpenDate, latestWeekDate, salesCR, latestDOM,
      lastRenewalRate, avgRenewalRate, lastRenewalLbl, firstRenewalLbl,
      updatedAt,
    },
  };
}

// ── Utilities ─────────────────────────────────────────────────
function tally(pages, keyFn, skipNull=false) {
  const out = {};
  pages.forEach(p => {
    const k = keyFn(p);
    if (!k && skipNull) return;
    out[k||'Unknown'] = (out[k||'Unknown']||0)+1;
  });
  return out;
}

function avgGroup(pages, keyFn, valFn) {
  const totals = {};
  pages.forEach(p => {
    const k = keyFn(p); const v = valFn(p);
    if (!k || !(v > 0)) return;
    totals[k] = totals[k] || {sum:0,n:0};
    totals[k].sum += v; totals[k].n++;
  });
  const out = {};
  Object.entries(totals).forEach(([k,{sum,n}]) => { out[k]=Math.round(sum/n); });
  return out;
}

// ── HTML Generator ─────────────────────────────────────────────
function generateHTML(D) {
  const m = D.meta;

  const statusColors = {
    'Resident Occupied':'#27ae60','Notice to Vacate':'#f39c12',
    'Future Move-in':'#2e7d9e','Vacant':'#c0392b',
    'Owner Occupied':'#8e44ad','No Status':'#95a5a6','Unknown':'#bdc3c7',
  };
  const statusTotal = Object.values(D.rentalStatus).reduce((a,b)=>a+b,0);
  const statusBar = Object.entries(D.rentalStatus)
    .sort((a,b)=>b[1]-a[1])
    .map(([s,n])=>`<div class="bar-seg" style="width:${(n/statusTotal*100).toFixed(1)}%;background:${statusColors[s]||'#95a5a6'}"></div>`)
    .join('');
  const statusLegend = Object.entries(D.rentalStatus)
    .sort((a,b)=>b[1]-a[1])
    .map(([s,n])=>`<div class="leg"><div class="dot" style="background:${statusColors[s]||'#95a5a6'}"></div>${s} — ${n}</div>`)
    .join('');

  const kpi = (color,label,value,sub) => `
    <div class="kpi ${color}">
      <div class="kl">${label}</div>
      <div class="kv">${value}</div>
      <div class="ks">${sub}</div>
    </div>`;

  const portfolioKPIs = [
    kpi('navy','Total Active Doors', D.kpis.totalDoors,    'ACTIVE · excl. KRB-01 · Rental Matrix'),
    kpi('blue','Available to Rent',  D.kpis.availToRent,   'ACTIVE · Revenue checked · Rental Matrix'),
    kpi('green','Occupied',          D.kpis.occupied,      'Has Resident linked · Rental Matrix'),
    kpi('teal','Occupancy Rate',     D.kpis.occupancyRate+'%', `${D.kpis.occupied} of ${D.kpis.availToRent} rentable`),
    kpi('purple','Sales Closing Ratio',(m.salesCR||'—')+'%',`Week of ${m.latestWeekDate} · Weekly KPI`),
    kpi('orange','Renewal Rate',     m.lastRenewalRate+'%',`${m.lastRenewalLbl} (most recent month)`),
    kpi('yellow','12-Mo Renewal Avg',m.avgRenewalRate+'%', `${m.firstRenewalLbl} – ${m.lastRenewalLbl}`),
    kpi('green','Avg Monthly Rent',  '$'+D.kpis.avgRent.toLocaleString(), `$${D.kpis.minRent.toLocaleString()} – $${D.kpis.maxRent.toLocaleString()}`),
  ].join('');

  const opsKPIs = [
    kpi('blue','Avg Speed to Repair',  m.latestSpeed,         `days · ${m.latestSpeedLbl}`),
    kpi('orange','Avg Turnover Time',  m.latestTurn,          `days · ${m.latestTurnLbl}`),
    kpi('red','Total Open WOs',        m.latestOpenWO,        `as of ${m.latestWeekDate}`),
    kpi('yellow','Avg Days on Market', m.latestDOM,           'Vacant properties · Weekly KPI'),
    kpi('purple','Sales Closing Ratio',(m.salesCR||'—')+'%', 'Latest week · Weekly KPI'),
  ].join('');

  const ownerKPIs = [
    kpi('navy',  'Active Owners',         D.owners.totalOwners,        'ACTIVE status · Owner Matrix'),
    kpi('blue',  'Total Make Readys',      D.owners.makeReadyCt,        'All time · DWOR database'),
    kpi('orange','Total Turnovers',        D.owners.turnoverCt,         'All time · DWOR database'),
    kpi('green', 'Avg Make Ready Days',    D.owners.avgMRDays,          'Average DWOR days · Make Ready'),
    kpi('red',   'Avg Turnover Days',      D.owners.avgTrnDays,         'Average DWOR days · Turnover'),
  ].join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KRB Rental Matrix Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"><\/script>
<style>
  :root{--primary:#1e3a5f;--accent:#2e7d9e;--green:#27ae60;--orange:#e67e22;--red:#c0392b;--yellow:#f39c12;--purple:#8e44ad;--teal:#16a085;--light-bg:#f4f7fb;--card-bg:#ffffff;--text:#1a2332;--muted:#6b7a90;--border:#e2e8f0}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;background:var(--light-bg);color:var(--text)}
  header{background:linear-gradient(135deg,var(--primary) 0%,#2a5298 100%);color:#fff;padding:20px 32px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 4px 16px rgba(0,0,0,.15)}
  header h1{font-size:1.5rem;font-weight:700}
  header p{font-size:.82rem;opacity:.75;margin-top:2px}
  .hbadge{background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.3);border-radius:20px;padding:5px 14px;font-size:.76rem;font-weight:600;white-space:nowrap}
  .tabs{display:flex;gap:2px;background:var(--primary);padding:0 32px}
  .tab{padding:10px 22px;font-size:.8rem;font-weight:600;color:rgba(255,255,255,.6);cursor:pointer;border-bottom:3px solid transparent;transition:.2s;white-space:nowrap}
  .tab.active{color:#fff;border-bottom-color:#fff}
  .tab:hover:not(.active){color:rgba(255,255,255,.85)}
  .container{max-width:1440px;margin:0 auto;padding:22px 24px 48px}
  .section{display:none}.section.active{display:block}
  .sec-title{font-size:.95rem;font-weight:700;color:var(--primary);margin-bottom:14px;padding-bottom:8px;border-bottom:2px solid var(--border);display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .sec-badge{font-size:.72rem;font-weight:500;color:var(--muted);background:var(--light-bg);padding:2px 10px;border-radius:20px;border:1px solid var(--border)}
  .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:14px;margin-bottom:20px}
  .kpi{background:var(--card-bg);border-radius:12px;padding:18px 20px;box-shadow:0 1px 4px rgba(0,0,0,.07);border:1px solid var(--border);position:relative;overflow:hidden}
  .kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:12px 12px 0 0}
  .kpi.blue::before{background:var(--accent)}.kpi.blue .kv{color:var(--accent)}
  .kpi.green::before{background:var(--green)}.kpi.green .kv{color:var(--green)}
  .kpi.orange::before{background:var(--orange)}.kpi.orange .kv{color:var(--orange)}
  .kpi.red::before{background:var(--red)}.kpi.red .kv{color:var(--red)}
  .kpi.yellow::before{background:var(--yellow)}.kpi.yellow .kv{color:var(--yellow)}
  .kpi.purple::before{background:var(--purple)}.kpi.purple .kv{color:var(--purple)}
  .kpi.teal::before{background:var(--teal)}.kpi.teal .kv{color:var(--teal)}
  .kpi.navy::before{background:var(--primary)}.kpi.navy .kv{color:var(--primary)}
  .kl{font-size:.67rem;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
  .kv{font-size:1.85rem;font-weight:800;line-height:1}
  .ks{font-size:.7rem;color:var(--muted);margin-top:4px}
  .strip{background:var(--card-bg);border-radius:12px;padding:16px 22px;box-shadow:0 1px 4px rgba(0,0,0,.07);border:1px solid var(--border);margin-bottom:18px}
  .strip h3{font-size:.72rem;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px;font-weight:700}
  .bar-track{height:18px;border-radius:9px;background:#eee;overflow:hidden;display:flex}
  .bar-seg{height:100%}
  .legend{display:flex;gap:16px;margin-top:10px;flex-wrap:wrap}
  .leg{display:flex;align-items:center;gap:6px;font-size:.78rem;font-weight:500}
  .dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
  .grid{display:grid;grid-template-columns:repeat(12,1fr);gap:16px;margin-bottom:18px}
  .card{background:var(--card-bg);border-radius:12px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.07);border:1px solid var(--border)}
  .c3{grid-column:span 3}.c4{grid-column:span 4}.c5{grid-column:span 5}
  .c6{grid-column:span 6}.c7{grid-column:span 7}.c8{grid-column:span 8}.c12{grid-column:span 12}
  .ct{font-size:.82rem;font-weight:700;color:var(--text);margin-bottom:2px}
  .cs{font-size:.69rem;color:var(--muted);margin-bottom:14px}
  .tscroll{overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:.79rem}
  thead tr{background:var(--light-bg)}
  th{font-weight:700;color:var(--muted);font-size:.67rem;text-transform:uppercase;letter-spacing:.4px;padding:9px 11px;text-align:left;border-bottom:2px solid var(--border);white-space:nowrap}
  td{padding:8px 11px;border-bottom:1px solid var(--border)}
  tbody tr:hover{background:#f8fafc}
  .chip{display:inline-block;padding:2px 8px;border-radius:20px;font-size:.69rem;font-weight:600;white-space:nowrap}
  .s-occ{background:#d4edda;color:#155724}.s-vac{background:#f8d7da;color:#721c24}
  .s-ntv{background:#fff3cd;color:#856404}.s-fut{background:#d1ecf1;color:#0c5460}
  .s-unk{background:#e2e8f0;color:#4a5568}
  .rv{font-weight:700;color:var(--green)}
  @media(max-width:900px){
    .c3,.c4,.c5,.c6,.c7,.c8{grid-column:span 12}
    header{flex-direction:column;gap:8px;align-items:flex-start}
  }
</style>
</head>
<body>

<header>
  <div>
    <h1>🏠 KRB Rental Matrix Dashboard</h1>
    <p>Keyrenter Boise · All Properties · Multi-Database Overview</p>
  </div>
  <div class="hbadge">Synced: ${m.updatedAt}</div>
</header>

<div class="tabs">
  <div class="tab active" onclick="showTab(0)">Portfolio Overview</div>
  <div class="tab" onclick="showTab(1)">Operations &amp; Maintenance</div>
  <div class="tab" onclick="showTab(2)">Property Details</div>
  <div class="tab" onclick="showTab(3)">Owners &amp; DWOR</div>
</div>

<div class="container">

<!-- TAB 0 -->
<div class="section active" id="tab0">
  <div class="sec-title">📊 Rental Matrix KPIs
    <span class="sec-badge">All Properties · Active · excl. KRB-01 · Live from Notion</span>
  </div>
  <div class="kpi-grid">${portfolioKPIs}</div>

  <div class="strip">
    <h3>Portfolio Occupancy Breakdown — Rental Status (${statusTotal} Revenue Properties · Rental Matrix)</h3>
    <div class="bar-track">${statusBar}</div>
    <div class="legend">${statusLegend}</div>
  </div>

  <div class="grid">
    <div class="card c4"><div class="ct">Rental Status</div><div class="cs">${statusTotal} revenue properties</div><canvas id="statusChart" height="230"></canvas></div>
    <div class="card c8"><div class="ct">Properties by City</div><div class="cs">Distribution across all markets</div><canvas id="cityChart" height="215"></canvas></div>
  </div>
  <div class="grid">
    <div class="card c5"><div class="ct">Average Rent by City</div><div class="cs">Monthly rent average per market</div><canvas id="rentCityChart" height="225"></canvas></div>
    <div class="card c7"><div class="ct">Monthly Renewal Rate</div><div class="cs">Renewed ÷ Expirations · past 12 months</div><canvas id="renewalChart" height="225"></canvas></div>
  </div>
  <div class="grid">
    <div class="card c8"><div class="ct">Monthly Revenue &amp; Door Count</div><div class="cs">Revenue (bars) vs filtered door count (line) · past 12 months</div><canvas id="revenueChart" height="235"></canvas></div>
    <div class="card c4"><div class="ct">Bedroom Distribution</div><div class="cs">Active properties</div><canvas id="bedsChart" height="235"></canvas></div>
  </div>
  <div class="grid">
    <div class="card c4"><div class="ct">Property Type</div><div class="cs">Active portfolio mix</div><canvas id="typeChart" height="230"></canvas></div>
    <div class="card c4"><div class="ct">HOA Properties</div><div class="cs">HOA status across active portfolio</div><canvas id="hoaChart" height="230"></canvas></div>
    <div class="card c4"><div class="ct">Management Fee Structure</div><div class="cs">Revenue properties · fee tier distribution</div><canvas id="feeChart" height="230"></canvas></div>
  </div>
</div>

<!-- TAB 1 -->
<div class="section" id="tab1">
  <div class="sec-title">🔧 Weekly KPI — Maintenance Metrics
    <span class="sec-badge">Weekly KPI Submissions · Past 180 Days</span>
  </div>
  <div class="kpi-grid">${opsKPIs}</div>
  <div class="grid">
    <div class="card c6"><div class="ct">Speed to Repair</div><div class="cs">Avg days to complete WO · by month · past 180 days</div><canvas id="speedChart" height="235"></canvas></div>
    <div class="card c6"><div class="ct">Turnover Time</div><div class="cs">Avg days to complete turnover · by month · past 180 days</div><canvas id="turnoverChart" height="235"></canvas></div>
  </div>
  <div class="grid">
    <div class="card c8"><div class="ct">Total Open Work Orders</div><div class="cs">Weekly totals · past 90 days · red = 60+, orange = 50+</div><canvas id="openWOChart" height="205"></canvas></div>
    <div class="card c4"><div class="ct">Year Built Decades</div><div class="cs">Portfolio age distribution</div><canvas id="yearChart" height="205"></canvas></div>
  </div>
  <div class="grid">
    <div class="card c5"><div class="ct">Avg Rent by Bedrooms</div><div class="cs">Monthly rent average per bedroom count</div><canvas id="rentBedsChart" height="220"></canvas></div>
    <div class="card c4"><div class="ct">HVAC Preventive Maintenance</div><div class="cs">Properties enrolled in KRB HVAC PM program</div><canvas id="hvacChart" height="220"></canvas></div>
    <div class="card c3"><div class="ct">Pool / Hot Tub</div><div class="cs">Properties with pool or hot tub</div><canvas id="poolChart" height="220"></canvas></div>
  </div>
</div>

<!-- TAB 3 -->
<div class="section" id="tab3">
  <div class="sec-title">🏘️ Owners &amp; DWOR
    <span class="sec-badge">Owner Matrix · DWOR Database · Live from Notion</span>
  </div>
  <div class="kpi-grid">${ownerKPIs}</div>
  <div class="grid">
    <div class="card c8"><div class="ct">Make Readys &amp; Turnovers by Month</div><div class="cs">Count per type · past 6 months · DWOR database</div><canvas id="dworTrendChart" height="235"></canvas></div>
    <div class="card c4"><div class="ct">Owner Portfolio Size</div><div class="cs">Active owners by number of SF rentals</div><canvas id="ownerDistChart" height="235"></canvas></div>
  </div>
  <div class="grid">
    <div class="card c6"><div class="ct">Average DWOR Days by Type</div><div class="cs">All-time average duration per work order type</div><canvas id="dworAvgChart" height="235"></canvas></div>
    <div class="card c6"><div class="ct">Owner Status</div><div class="cs">Active vs inactive owners · Owner Matrix</div><canvas id="ownerStatusChart" height="235"></canvas></div>
  </div>
</div>

<!-- TAB 2 -->
<div class="section" id="tab2">
  <div class="sec-title">🏡 Property Details
    <span class="sec-badge">Rental Matrix · All Properties · Active</span>
  </div>
  <div class="grid">
    <div class="card c12">
      <div class="ct">Top 15 Properties by Monthly Rent</div>
      <div class="cs">Highest-value active properties · Rental Matrix</div>
      <div class="tscroll">
        <table>
          <thead><tr><th>#</th><th>Address</th><th>City</th><th>Type</th><th>Beds</th><th>Baths</th><th>Monthly Rent</th><th>Status</th></tr></thead>
          <tbody id="propsTbody"></tbody>
        </table>
      </div>
    </div>
  </div>
  <div class="grid">
    <div class="card c5"><div class="ct">Bedroom Distribution</div><div class="cs">All active properties</div><canvas id="bedsChart2" height="215"></canvas></div>
    <div class="card c7"><div class="ct">Average Rent by City</div><div class="cs">Monthly rent average per market</div><canvas id="rentCityChart2" height="215"></canvas></div>
  </div>
</div>

</div>

<script>
const tabs=document.querySelectorAll('.tab');
const sections=document.querySelectorAll('.section');
function showTab(i){tabs.forEach((t,j)=>t.classList.toggle('active',i===j));sections.forEach((s,j)=>s.classList.toggle('active',i===j));}

const D=${JSON.stringify(D)};

const PAL={
  status:['#27ae60','#c0392b','#f39c12','#2e7d9e','#8e44ad','#95a5a6','#bdc3c7'],
  mixed: ['#2e7d9e','#27ae60','#e67e22','#9b59b6','#c0392b','#1abc9c','#f39c12','#34495e'],
  green: ['#1a5c38','#27ae60','#52c17a','#7dd49c','#a9e4be'],
  decade:['#95a5a6','#7f8c8d','#2980b9','#27ae60','#2e7d9e','#1e3a5f','#e67e22'],
  beds:  ['#2e7d9e','#27ae60','#e67e22','#9b59b6','#c0392b']
};

function donut(id,labels,vals,colors){new Chart(document.getElementById(id),{type:'doughnut',data:{labels,datasets:[{data:vals,backgroundColor:colors,borderWidth:2,borderColor:'#fff',hoverOffset:5}]},options:{responsive:true,maintainAspectRatio:false,cutout:'60%',plugins:{legend:{position:'bottom',labels:{padding:10,font:{size:10},boxWidth:10}},tooltip:{callbacks:{label:c=>\` \${c.label}: \${c.raw}\`}}}}});}
function hbar(id,labels,vals,colors,suffix=''){new Chart(document.getElementById(id),{type:'bar',data:{labels,datasets:[{data:vals,backgroundColor:colors,borderRadius:5,borderSkipped:false}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>\` \${c.raw}\${suffix}\`}}},scales:{x:{grid:{color:'#f0f0f0'},ticks:{font:{size:10}}},y:{grid:{display:false},ticks:{font:{size:10}}}}}});}
function vbar(id,labels,vals,colors,opts={}){new Chart(document.getElementById(id),{type:'bar',data:{labels,datasets:[{data:vals,backgroundColor:colors,borderRadius:5,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>\`\${opts.pre||''} \${typeof c.raw==='number'&&opts.money?'$'+c.raw.toLocaleString():c.raw}\${opts.suf||''}\`}}},scales:{x:{grid:{color:'#f0f0f0'},ticks:{font:{size:10}}},y:{grid:{color:'#f0f0f0'},ticks:{font:{size:10},callback:opts.yFmt||undefined}}}}});}
function line(id,labels,datasets,opts={}){new Chart(document.getElementById(id),{type:'line',data:{labels,datasets:datasets.map(d=>({label:d.label,data:d.data,borderColor:d.color,backgroundColor:d.color+'22',pointBackgroundColor:d.color,pointRadius:4,pointHoverRadius:6,borderWidth:2.5,tension:0.35,fill:d.fill||false}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:datasets.length>1,position:'top',labels:{font:{size:10},boxWidth:10}},tooltip:{callbacks:{label:c=>\`\${c.dataset.label}: \${opts.pre||''}\${c.raw}\${opts.suf||''}\`}}},scales:{x:{grid:{color:'#f0f0f0'},ticks:{font:{size:10}}},y:{grid:{color:'#f0f0f0'},ticks:{font:{size:10},callback:opts.yFmt||undefined},suggestedMin:opts.yMin,suggestedMax:opts.yMax}}}});}

donut('statusChart',Object.keys(D.rentalStatus),Object.values(D.rentalStatus),PAL.status);
hbar('cityChart',Object.keys(D.cities),Object.values(D.cities),Object.keys(D.cities).map((_,i)=>PAL.mixed[i%PAL.mixed.length]),' properties');
{const e=Object.entries(D.avgRentCity).sort((a,b)=>b[1]-a[1]);vbar('rentCityChart',e.map(x=>x[0]),e.map(x=>x[1]),e.map((_,i)=>PAL.mixed[i%PAL.mixed.length]),{money:true,yFmt:v=>'$'+v.toLocaleString()});}
vbar('bedsChart',Object.keys(D.bedrooms),Object.values(D.bedrooms),PAL.beds,{suf:' properties'});
line('renewalChart',D.renewalLabels,[{label:'Renewal Rate %',data:D.renewalVals,color:'#27ae60',fill:true}],{suf:'%',yMin:40,yMax:100,yFmt:v=>v+'%'});
{const ctx=document.getElementById('revenueChart');new Chart(ctx,{type:'bar',data:{labels:D.revLabels,datasets:[{type:'bar',label:'Revenue',data:D.revVals,backgroundColor:'#2e7d9e33',borderColor:'#2e7d9e',borderWidth:1,yAxisID:'y',borderRadius:4},{type:'line',label:'Door Count',data:D.doorVals,borderColor:'#e67e22',backgroundColor:'transparent',pointBackgroundColor:'#e67e22',pointRadius:4,borderWidth:2.5,tension:.35,yAxisID:'y2'}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{font:{size:10},boxWidth:10}}},scales:{y:{grid:{color:'#f0f0f0'},ticks:{font:{size:10},callback:v=>'$'+Math.round(v/1000)+'k'},position:'left'},y2:{grid:{display:false},ticks:{font:{size:10}},position:'right'},x:{grid:{color:'#f0f0f0'},ticks:{font:{size:10}}}}}});}
donut('typeChart',Object.keys(D.propTypes),Object.values(D.propTypes),['#2e7d9e','#27ae60','#e67e22','#9b59b6']);
donut('hoaChart',Object.keys(D.hoa),Object.values(D.hoa),['#27ae60','#bdc3c7','#e67e22']);
donut('feeChart',Object.keys(D.mgmtFees),Object.values(D.mgmtFees),['#1e3a5f','#2e7d9e','#4d9cc4']);

line('speedChart',D.speedLabels,[{label:'Avg Speed to Repair (days)',data:D.speedVals,color:'#2e7d9e',fill:true}],{suf:' days',yMin:0,yFmt:v=>v+' d'});
line('turnoverChart',D.turnLabels,[{label:'Avg Turnover Time (days)',data:D.turnVals,color:'#e67e22',fill:true}],{suf:' days',yMin:15,yMax:28,yFmt:v=>v+' d'});
vbar('openWOChart',D.openLabels,D.openVals,D.openVals.map(v=>v>=60?'#c0392b':v>=50?'#e67e22':'#2e7d9e'),{suf:' open WOs'});
vbar('yearChart',D.yearBuilt.map(x=>x[0]),D.yearBuilt.map(x=>x[1]),PAL.decade,{suf:' properties'});
vbar('rentBedsChart',Object.keys(D.avgRentBeds),Object.values(D.avgRentBeds),PAL.green,{money:true,yFmt:v=>'$'+v.toLocaleString()});
donut('hvacChart',Object.keys(D.hvac),Object.values(D.hvac),['#27ae60','#c0392b','#e67e22','#bdc3c7','#f39c12']);
donut('poolChart',Object.keys(D.pool),Object.values(D.pool),['#2e7d9e','#95a5a6','#e2e8f0']);

vbar('bedsChart2',Object.keys(D.bedrooms),Object.values(D.bedrooms),PAL.beds,{suf:' properties'});
{const e=Object.entries(D.avgRentCity).sort((a,b)=>b[1]-a[1]);vbar('rentCityChart2',e.map(x=>x[0]),e.map(x=>x[1]),e.map((_,i)=>PAL.mixed[i%PAL.mixed.length]),{money:true,yFmt:v=>'$'+v.toLocaleString()});}

const SC={'Resident Occupied':'s-occ','Vacant':'s-vac','Notice to Vacate':'s-ntv','Future Move-in':'s-fut'};
const tb=document.getElementById('propsTbody');
D.topProps.forEach((p,i)=>{tb.innerHTML+=\`<tr><td style="color:var(--muted);font-weight:600">\${i+1}</td><td>\${p.a}</td><td>\${p.c}</td><td>\${p.t}</td><td>\${p.b}</td><td>\${p.ba}</td><td class="rv">$\${p.r.toLocaleString()}</td><td><span class="chip \${SC[p.s]||'s-unk'}">\${p.s}</span></td></tr>\`;});

// Tab 3 — Owners & DWOR charts
{const ctx=document.getElementById('dworTrendChart');new Chart(ctx,{type:'bar',data:{labels:D.dworLabels,datasets:[{label:'Make Ready',data:D.dworMR,backgroundColor:'#2e7d9e',borderRadius:4,borderSkipped:false},{label:'Turnover',data:D.dworTrn,backgroundColor:'#e67e22',borderRadius:4,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{font:{size:10},boxWidth:10}}},scales:{x:{grid:{color:'#f0f0f0'},ticks:{font:{size:10}}},y:{grid:{color:'#f0f0f0'},ticks:{font:{size:10},stepSize:1}}}}});}
donut('ownerDistChart',Object.keys(D.ownerDist),Object.values(D.ownerDist),['#1e3a5f','#2e7d9e','#27ae60','#e67e22']);
vbar('dworAvgChart',['Make Ready','Turnover'],[D.owners.avgMRDays,D.owners.avgTrnDays],['#2e7d9e','#e67e22'],{suf:' days'});
donut('ownerStatusChart',['Active','Inactive'],[D.owners.totalOwners,D.owners.inactiveOwners],['#27ae60','#e2e8f0']);
<\/script>
</body>
</html>`;
}

build().catch(err => { console.error('Build failed:', err.message); process.exit(1); });
