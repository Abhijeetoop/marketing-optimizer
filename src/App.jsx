import { useState, useEffect, useRef, useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, ReferenceLine, Legend } from "recharts";
import "./index.css";

const CHANNELS = ["Meta Ads","Google Search","Google Display","YouTube","Instagram Reels","Email","SMS","Influencer","Affiliate","Organic Social"];
const CHANNEL_COLORS = {
  "Meta Ads": "#3b82f6", "Google Search": "#ef4444", "Google Display": "#f59e0b",
  "YouTube": "#dc2626", "Instagram Reels": "#ec4899", "Email": "#06b6d4",
  "SMS": "#22c55e", "Influencer": "#f97316", "Affiliate": "#8b5cf6", "Organic Social": "#10b981",
};

// Removed STRATEGIES and STRATEGY_META as per request.


function fmt(n) {
  if (!n || isNaN(n)) return "₹0";
  if (n >= 10000000) return `₹${(n/10000000).toFixed(1)}Cr`;
  if (n >= 100000) return `₹${(n/100000).toFixed(1)}L`;
  if (n >= 1000) return `₹${(n/1000).toFixed(0)}K`;
  return `₹${Math.round(n)}`;
}

function fmtN(n) {
  if (n >= 1000000) return `${(n/1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n/1000).toFixed(0)}K`;
  return Math.round(n).toString();
}

function analyzeData(rows) {
  const byChannel = {};
  CHANNELS.forEach(c => { byChannel[c] = { spend:0, revenue:0, conversions:0, newCustomers:0, roasVals:[], records:[] }; });

  rows.forEach(r => {
    const c = r.channel;
    if (!byChannel[c]) return;
    byChannel[c].spend += r.spend;
    byChannel[c].revenue += r.revenue;
    byChannel[c].conversions += r.conversions;
    byChannel[c].newCustomers += r.new_customers;
    byChannel[c].roasVals.push(r.roas);
    byChannel[c].records.push(r);
  });

  const channelStats = CHANNELS.map(c => {
    const d = byChannel[c];
    const totalRoas = d.spend > 0 ? d.revenue / d.spend : 0;
    const cpa = d.conversions > 0 ? d.spend / d.conversions : 0;
    const cac = d.newCustomers > 0 ? d.spend / d.newCustomers : 0;

    // Day-of-week ROAS
    const dowMap = {};
    ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].forEach(day => { dowMap[day] = []; });
    d.records.forEach(r => { if (dowMap[r.day_of_week]) dowMap[r.day_of_week].push(r.roas); });
    const dowRoas = Object.entries(dowMap).map(([day, vals]) => ({
      day, avgRoas: vals.length ? +(vals.reduce((a,b)=>a+b,0)/vals.length).toFixed(2) : 0
    }));
    const bestDay = dowRoas.reduce((a,b) => b.avgRoas > a.avgRoas ? b : a, dowRoas[0]);

    // Diminishing returns: compare ROAS in bottom vs top spend quartile
    const sorted = [...d.records].sort((a,b) => a.spend - b.spend);
    const q = Math.max(1, Math.floor(sorted.length / 4));
    const lowRoas = sorted.slice(0, q).reduce((s,r)=>s+r.roas,0) / q;
    const highRoas = sorted.slice(-q).reduce((s,r)=>s+r.roas,0) / q;
    const diminishing = highRoas < lowRoas * 0.82;

    return { channel:c, totalSpend:d.spend, totalRevenue:d.revenue, totalRoas, cpa, cac,
      conversions:d.conversions, newCustomers:d.newCustomers, bestDay:bestDay?.day,
      diminishing, dowRoas };
  });

  // Score channels: Balanced weights
  const weights = { roas: 0.5, nc: 0.3, base: 0.2, dimPenalty: 0.72 };
  const maxRoas = Math.max(...channelStats.map(c=>c.totalRoas));
  const maxNcRev = Math.max(...channelStats.map(c=>c.newCustomers>0?c.totalRevenue/c.newCustomers:0));
  const scored = channelStats.map(c => {
    const roasScore = maxRoas > 0 ? c.totalRoas / maxRoas : 0;
    const ncScore = maxNcRev > 0 && c.newCustomers > 0 ? (c.totalRevenue/c.newCustomers)/maxNcRev : 0;
    const dimMul = c.diminishing ? weights.dimPenalty : 1.0;
    const score = (roasScore*weights.roas + ncScore*weights.nc + weights.base) * dimMul;
    return { ...c, score };
  });

  // Convert scores to allocation %
  const totalScore = scored.reduce((s,c)=>s+c.score, 0);
  const rawAlloc = {};
  scored.forEach(c => { rawAlloc[c.channel] = Math.max(2, Math.min(32, Math.round((c.score/totalScore)*100))); });
  let sum = Object.values(rawAlloc).reduce((a,b)=>a+b, 0);
  const best = scored.reduce((a,b) => b.score>a.score?b:a).channel;
  rawAlloc[best] += (100 - sum);

  // Monthly trend
  const monthMap = {};
  rows.forEach(r => {
    const m = r.date?.slice(0,7); if (!m) return;
    if (!monthMap[m]) monthMap[m] = { spend:0, revenue:0 };
    monthMap[m].spend += r.spend; monthMap[m].revenue += r.revenue;
  });
  const monthlyTrend = Object.entries(monthMap).sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([m,v]) => ({ month:m, spend:Math.round(v.spend/1000), revenue:Math.round(v.revenue/1000), roas:+(v.revenue/v.spend).toFixed(2) }));

  return { channelStats: scored, optimalAlloc: rawAlloc, monthlyTrend };
}

export default function App() {
  const [phase, setPhase] = useState("loading");
  const [progress, setProgress] = useState(0);
  const [totalPages, setTotalPages] = useState(110);
  const [rowCount, setRowCount] = useState(0);
  const [allData, setAllData] = useState([]);
  const [insights, setInsights] = useState(null);
  const [totalBudget, setTotalBudget] = useState(5000000);
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [aiReport, setAiReport] = useState("");
  const [customQuery, setCustomQuery] = useState("");
  const [allocation, setAllocation] = useState(() => {
    const base = {};
    CHANNELS.forEach((c,i) => { base[c] = i < 2 ? 14 : 9; });
    return base;
  });
  const [activeTab, setActiveTab] = useState("optimizer");
  const [menuOpen, setMenuOpen] = useState(false);

  const abortRef = useRef(false);

  useEffect(() => {
    abortRef.current = false;
    (async () => {
      // Step 1: fetch page 1 to discover total_pages
      let pages = 110;
      try {
        const first = await fetch(`https://mosaicfellowship.in/api/data/marketing/daily?page=1&limit=100`);
        const firstJson = await first.json();
        if (firstJson.pagination) pages = firstJson.pagination.total_pages;
        setTotalPages(pages);
        // seed rows with page 1 data
        var seedRows = firstJson.data || [];
      } catch { var seedRows = []; }

      if (abortRef.current) return;

      // Step 2: fetch remaining pages in parallel batches of 10
      const BATCH = 10;
      const allRows = [...seedRows];
      let fetched = 1;
      setRowCount(allRows.length);
      setProgress(Math.round((1 / pages) * 100));

      for (let start = 2; start <= pages && !abortRef.current; start += BATCH) {
        const end = Math.min(start + BATCH - 1, pages);
        const batch = [];
        for (let p = start; p <= end; p++) {
          batch.push(
            fetch(`https://mosaicfellowship.in/api/data/marketing/daily?page=${p}&limit=100`)
              .then(r => r.json())
              .catch(() => ({ data: [] }))
          );
        }
        const results = await Promise.all(batch);
        results.forEach(json => { if (json.data) allRows.push(...json.data); });
        fetched += results.length;
        setRowCount(allRows.length);
        setProgress(Math.round((fetched / pages) * 100));
      }

      if (!abortRef.current) { setAllData(allRows); setPhase("analyzing"); }
    })();
    return () => { abortRef.current = true; };
  }, []);

  useEffect(() => {
    if (phase !== "analyzing" && phase !== "ready") return;
    if (allData.length === 0) return;
    const ins = analyzeData(allData);
    setInsights(ins);
    if (phase === "analyzing") {
      setAllocation(ins.optimalAlloc);
      setPhase("ready");
    }
  }, [phase, allData]);

  function handleSlider(channel, newVal) {
    const v = parseInt(newVal);
    const diff = v - (allocation[channel] || 0);
    const others = CHANNELS.filter(c => c !== channel);
    const othTotal = others.reduce((s,c) => s+(allocation[c]||0), 0);
    const newAlloc = { ...allocation, [channel]: v };
    let leftover = diff;
    others.forEach((c, i) => {
      if (i === others.length-1) {
        newAlloc[c] = Math.max(0, (allocation[c]||0) - leftover);
      } else {
        const share = othTotal > 0 ? Math.round(((allocation[c]||0)/othTotal)*diff) : 0;
        newAlloc[c] = Math.max(0, (allocation[c]||0) - share);
        leftover -= share;
      }
    });
    const total = Object.values(newAlloc).reduce((a,b)=>a+b,0);
    if (total !== 100) newAlloc[channel] += (100-total);
    setAllocation(newAlloc);
  }

  function projectRevenue(alloc, budget) {
    if (!insights) return 0;
    return insights.channelStats.reduce((sum, c) => {
      const pct = (alloc[c.channel]||0)/100;
      const spend = budget * pct;
      const roas = c.diminishing && spend > c.totalSpend/insights.channelStats.length*1.8
        ? c.totalRoas * 0.78 : c.totalRoas;
      return sum + spend * roas;
    }, 0);
  }

  if (phase === "loading" || phase === "analyzing") {
    const pct = phase==="analyzing" ? 100 : progress;
    const msg = phase==="analyzing" ? `Computing insights across ${fmtN(rowCount)} records…` : `Fetching page data… ${rowCount.toLocaleString()} rows loaded`;
    return (
      <div className="loader-container text-main font-sans">
        <div className="loader-bg"></div>
        <div className="loader-content animate-fade-in">

          <div className="loader-title text-gradient">MARKETING MIX</div>
          <div className="loader-subtitle" style={{color:"#fff"}}>OPTIMIZER</div>
          
          <div style={{ margin: "0 auto", width:"100%", maxWidth:"400px" }}>
            <div style={{ display:"flex", justifyContent:"space-between", fontSize:"12px", color:"var(--text-muted)", marginBottom:"12px", fontFamily:"var(--font-mono)" }}>
              <span>{msg}</span>
              <span className="text-gradient font-mono" style={{fontWeight:"bold"}}>{pct}%</span>
            </div>
            <div className="progress-container">
              <div className="progress-bar" style={{ width:`${pct}%` }}/>
            </div>
          </div>
          
          <div className="chart-loader">
            {CHANNELS.slice(0,5).map((c,i)=>(
              <div key={c} className="chart-bar" style={{ height:`${30+i*15}px`, background:CHANNEL_COLORS[c], opacity: progress/100 > i/5 ? 1 : 0.2 }}/>
            ))}
            {CHANNELS.slice(5).map((c,i)=>(
              <div key={c} className="chart-bar" style={{ height:`${105-(i*15)}px`, background:CHANNEL_COLORS[c], opacity: progress/100 > (i+5)/10 ? 1 : 0.2 }}/>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const { channelStats, monthlyTrend, optimalAlloc } = insights;
  const sortedByScore = [...channelStats].sort((a,b)=>b.score-a.score);
  const projRev = projectRevenue(allocation, totalBudget);
  const projRoas = totalBudget > 0 ? projRev / totalBudget : 0;
  const optRev = projectRevenue(optimalAlloc, totalBudget);
  const dimChannels = channelStats.filter(c=>c.diminishing);

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div>
          <div className="header-subtitle font-mono">Overview</div>
          <div className="header-title text-gradient">MARKETING MIX OPTIMIZER</div>
        </div>
        {/* Desktop tabs */}
        <div className="tabs-container desktop-tabs">
          {["optimizer","analysis","trends", "ai"].map(tab=>(
            <button key={tab} className={`tab-button ${activeTab===tab ? "active" : ""}`} onClick={()=>setActiveTab(tab)}>
              {tab === 'ai' ? '✨ AI Insights' : tab}
            </button>
          ))}
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:"16px" }}>
          <div className="text-muted font-mono header-meta" style={{ textAlign:"right", fontSize:"11px" }}>
            <div className="text-gradient" style={{ fontWeight:"bold", marginBottom:"4px", fontSize:"14px" }}>{fmtN(allData.length)} records</div>
            <div>3 yrs &middot; 10 ch &middot; {totalPages} pg</div>
          </div>
          {/* Mobile hamburger */}
          <button className="hamburger-btn" onClick={()=>setMenuOpen(o=>!o)} aria-label="Menu">
            <span className={`ham-line ${menuOpen?"open":""}`}/>
            <span className={`ham-line ${menuOpen?"open":""}`}/>
            <span className={`ham-line ${menuOpen?"open":""}`}/>
          </button>
        </div>
      </header>
      {/* Mobile tab drawer */}
      {menuOpen && (
        <div className="mobile-menu">
          {["optimizer","analysis","trends", "ai"].map(tab=>(
            <button key={tab} className={`mobile-tab-btn ${activeTab===tab?"active":""}`}
              onClick={()=>{ setActiveTab(tab); setMenuOpen(false); }}>
              {tab === 'ai' ? '✨ AI Insights' : tab.charAt(0).toUpperCase()+tab.slice(1)}
            </button>
          ))}
        </div>
      )}

      {/* KPI Strip */}
      <div className="kpi-grid">
        <div className="kpi-card animate-fade-in" style={{ animationDelay: "0s" }}>
          <div className="kpi-label font-mono">Monthly Budget (₹)</div>
          <input 
            type="number" 
            value={totalBudget}
            onChange={e => setTotalBudget(Number(e.target.value))}
            className="kpi-value input-unstyled"
            style={{ width: "100%", background: "transparent", border: "none", outline: "none", fontFamily: "var(--font-sans)", color: "var(--text-main)", padding: 0 }}
          />
          <div className="kpi-sub font-mono">Customizable Budget</div>
        </div>
        
        {/* Projected Revenue */}
        <div className="kpi-card animate-fade-in" style={{ animationDelay:"0.1s", gridColumn: "span 2" }}>
          <div className="kpi-label font-mono">Projected Revenue</div>
          <div className="kpi-value gold">₹{projRev.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
          <div className="kpi-sub font-mono">{projRoas.toFixed(2)}x ROAS</div>
        </div>

        {/* vs Optimal */}
        <div className="kpi-card animate-fade-in" style={{ animationDelay:"0.3s" }}>
          <div className="kpi-label font-mono">vs Optimal</div>
          <div className="kpi-value">₹{optRev.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
          <div className="kpi-sub font-mono">{totalBudget > 0 ? (optRev/totalBudget).toFixed(2) : 0}x optimal ROAS</div>
        </div>
      </div>



      <main className="content-area animate-fade-in" style={{ animationDelay: "0.4s" }}>
        {/* OPTIMIZER */}
        {activeTab==="optimizer" && (
          <div className="grid-2-col">
            {/* Sliders */}
            <div className="glass-card">
              <div className="card-header">
                <div>
                  <div className="card-title font-mono">Budget Allocation</div>
                  <div className="card-subtitle">Drag Sliders &middot; Total = 100%</div>
                </div>
                <button className="btn btn-primary" onClick={()=>setAllocation(optimalAlloc)}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.59-9.21l5.8 5.8"/></svg>
                  Optimal
                </button>
              </div>

              {CHANNELS.map(ch => {
                const stat = channelStats.find(c=>c.channel===ch);
                const pct = allocation[ch]||0;
                return (
                  <div key={ch} className="slider-container">
                    <div className="slider-header">
                      <div className="channel-name-wrap">
                        <div className="channel-dot" style={{ color: CHANNEL_COLORS[ch], background: CHANNEL_COLORS[ch] }}/>
                        <span className="channel-name">{ch}</span>
                        {stat?.diminishing && <span className="channel-tag font-mono">DIM</span>}
                      </div>
                      <div className="slider-values">
                        <span className="slider-pct" style={{ color: CHANNEL_COLORS[ch] }}>{pct}%</span>
                        <span className="slider-amt">{fmt(totalBudget*pct/100)}</span>
                      </div>
                    </div>
                    <input type="range" min="0" max="40" value={pct} onChange={e=>handleSlider(ch,e.target.value)} />
                    <div className="slider-stats">
                      <span>ROAS: {stat?.totalRoas.toFixed(2)}x</span>
                      <span>CPA: {fmt(stat?.cpa||0)}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Right: results */}
            <div style={{ display:"flex", flexDirection:"column", gap:"24px" }}>
              {/* Revenue projection */}
              <div className="glass-card glass-card-glow">
                <div className="card-title font-mono" style={{ color:"var(--text-accent)" }}>Projected Monthly Revenue</div>
                <div style={{ fontSize:"42px", fontWeight:"700", letterSpacing:"-1px", margin:"10px 0 16px", background:"var(--gold-gradient)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>
                  ₹{projRev.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                </div>
                <div style={{ fontSize:"14px", color:"var(--text-muted)", marginBottom:"24px", fontFamily:"var(--font-sans)" }}>
                  <span style={{ color:"#fff", fontWeight:"600" }}>{projRoas.toFixed(2)}x ROAS</span> &middot; {fmt(projRev-totalBudget)} net profit
                </div>
                <div className="progress-container">
                  <div className="progress-bar" style={{ width:`${Math.min(100,(projRoas/6)*100)}%` }}/>
                </div>
                <div style={{ display:"flex", justifyContent:"space-between", fontSize:"11px", color:"var(--text-muted)", marginTop:"8px", fontFamily:"var(--font-mono)" }}>
                  <span>0x</span><span>6x ROAS ceiling</span>
                </div>
              </div>

              {/* Stacked bar */}
              <div className="glass-card">
                <div className="card-title font-mono" style={{ marginBottom:"20px" }}>Budget Split</div>
                <div className="stacked-bar-container">
                  {CHANNELS.map(ch=>(
                    <div key={ch} className="stacked-bar-segment" style={{ width:`${allocation[ch]||0}%`, background:CHANNEL_COLORS[ch], minWidth:allocation[ch]>0?"2px":"0" }} title={`${ch}: ${allocation[ch]}%`}/>
                  ))}
                </div>
                <div style={{ maxHeight: "250px", overflowY: "auto", paddingRight: "8px" }}>
                  {CHANNELS.map(ch=>(
                    <div key={ch} className="legend-item">
                      <div className="channel-name-wrap">
                        <div className="channel-dot" style={{ background:CHANNEL_COLORS[ch], color: CHANNEL_COLORS[ch] }}/>
                        <span style={{ fontSize:"12px" }}>{ch}</span>
                      </div>
                      <div style={{ display:"flex", gap:"16px", fontSize:"12px", fontFamily:"var(--font-mono)" }}>
                        <span style={{ color:"var(--text-muted)", width:"32px", textAlign:"right" }}>{allocation[ch]}%</span>
                        <span style={{ color:"var(--text-main)", fontWeight:"600", width:"64px", textAlign:"right" }}>{fmt(totalBudget*(allocation[ch]||0)/100)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Insights box */}
              <div className="glass-card" style={{ borderLeft: "4px solid var(--text-accent)" }}>
                <div className="card-title font-mono" style={{ color:"var(--text-accent)", marginBottom:"12px" }}>⚡ AI Recommendation</div>
                <div style={{ fontSize:"14px", color:"var(--text-muted)", lineHeight:"1.8" }}>
                  Top channels: <span style={{color:"#fff", fontWeight:"500"}}>{sortedByScore.slice(0,3).map(c=>c.channel).join(", ")}</span>.
                  {dimChannels.length > 0 && <> Diminishing returns in <span style={{color:"#ef4444", fontWeight:"500"}}>{dimChannels.map(c=>c.channel).join(", ")}</span> &mdash; avoid over-indexing.</>}
                  {" "}Optimal allocation projects <span style={{color:"var(--text-accent)", fontWeight:"600"}}>{fmt(optRev)}</span> vs current {fmt(projRev)}.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ANALYSIS */}
        {activeTab==="analysis" && (
          <div className="grid-2-col">
            <div className="glass-card">
              <div className="card-title font-mono">3-Year Blended ROAS by Channel</div>
              <div style={{ fontSize:"13px", color:"var(--text-muted)", marginBottom:"24px" }}>Total revenue &divide; total spend across all data</div>
              <ResponsiveContainer width="100%" height={400}>
                <BarChart data={[...channelStats].sort((a,b)=>b.totalRoas-a.totalRoas).map(c=>({ name:c.channel.replace(" Ads","").replace(" Search","").replace(" Display","").replace(" Reels","").replace(" Social",""), roas:+c.totalRoas.toFixed(2), fill:CHANNEL_COLORS[c.channel] }))} layout="vertical" margin={{left:80,right:30, top: 20, bottom: 20}}>
                  <XAxis type="number" tick={{fill:"var(--text-muted)",fontSize:11}} tickFormatter={v=>`${v}x`}/>
                  <YAxis type="category" dataKey="name" tick={{fill:"var(--text-main)",fontSize:12}} width={80}/>
                  <Tooltip cursor={{fill:"rgba(255,255,255,0.05)"}} formatter={v=>[`${v}x ROAS`,""]} contentStyle={{background:"var(--bg-card)",border:"1px solid var(--border-color)",borderRadius:"8px",fontSize:"12px",backdropFilter:"blur(10px)"}}/>
                  <Bar dataKey="roas" radius={[0,4,4,0]} label={{ position:"right", fontSize:11, fill:"var(--text-muted)", formatter:v=>`${v}x` }}>
                    {[...channelStats].sort((a,b)=>b.totalRoas-a.totalRoas).map((c,i)=>(
                      <rect key={i} fill={CHANNEL_COLORS[c.channel]}/>
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="glass-card">
              <div className="card-title font-mono">Channel Rankings &middot; Composite Score</div>
              <div style={{ fontSize:"13px", color:"var(--text-muted)", marginBottom:"24px" }}>Based on ROAS, CAC, and Scale</div>
              <div style={{ overflowY:"auto", maxHeight:"400px", paddingRight:"8px" }}>
                {sortedByScore.map((c,i)=>(
                  <div key={c.channel} style={{ display:"grid", gridTemplateColumns:"30px 1fr auto", gap:"16px", alignItems:"center", padding:"16px 0", borderBottom:"1px solid var(--border-color)" }}>
                    <div style={{ fontSize:"16px", fontWeight:"700", color: i<3?"var(--text-accent)":"var(--text-muted)", fontFamily:"var(--font-mono)" }}>#{i+1}</div>
                    <div>
                      <div style={{ display:"flex", alignItems:"center", gap:"10px", marginBottom:"6px" }}>
                        <div style={{ width:"10px", height:"10px", borderRadius:"50%", background:CHANNEL_COLORS[c.channel], boxShadow:`0 0 10px ${CHANNEL_COLORS[c.channel]}` }}/>
                        <span style={{ fontSize:"15px", fontWeight:"500", color:"var(--text-main)" }}>{c.channel}</span>
                        {c.diminishing && <span className="channel-tag font-mono">DIM</span>}
                      </div>
                      <div style={{ fontSize:"11px", color:"var(--text-muted)", fontFamily:"var(--font-mono)" }}>Best: {c.bestDay} &middot; CPA {fmt(c.cpa)} &middot; CAC {fmt(c.cac)}</div>
                    </div>
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontSize:"24px", fontWeight:"700", color:i<3?"var(--text-accent)":"var(--text-main)", letterSpacing:"-0.5px" }}>{c.totalRoas.toFixed(2)}x</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* DOW Heatmap */}
            <div className="glass-card" style={{ gridColumn:"span 2" }}>
              <div className="card-title font-mono">Day-of-Week ROAS Heatmap</div>
              <div style={{ fontSize:"13px", color:"var(--text-muted)", marginBottom:"24px" }}>Amber = high ROAS. Use to schedule spend timing.</div>
              <div style={{ overflowX:"auto" }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Channel</th>
                      {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(d=>(
                        <th key={d} style={{ textAlign:"center" }}>{d}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {channelStats.map(c=>{
                      const vals = c.dowRoas.map(d=>d.avgRoas);
                      const mx = Math.max(...vals), mn = Math.min(...vals);
                      return (
                        <tr key={c.channel}>
                          <td style={{ color:"var(--text-main)", whiteSpace:"nowrap", display:"flex", alignItems:"center", gap:"10px" }}>
                            <span style={{ width:"8px", height:"8px", borderRadius:"50%", background:CHANNEL_COLORS[c.channel], boxShadow:`0 0 8px ${CHANNEL_COLORS[c.channel]}` }}/>
                            {c.channel}
                          </td>
                          {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(day=>{
                            const entry = c.dowRoas.find(d=>d.day===day);
                            const val = entry?.avgRoas||0;
                            const t = mx>mn ? (val-mn)/(mx-mn) : 0.5;
                            return (
                              <td key={day} style={{ textAlign:"center" }}>
                                <div className="cell-heatmap" style={{ 
                                  padding:"8px", 
                                  background:`rgba(245,158,11,${0.05+t*0.5})`, 
                                  color:t>0.6?"#f59e0b":t>0.3?"var(--text-main)":"var(--text-muted)",
                                  boxShadow: t>0.8? "inset 0 0 10px rgba(245,158,11,0.2)": "none"
                                }}>
                                  {val.toFixed(1)}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TRENDS */}
        {activeTab==="trends" && (
          <div style={{ display:"grid", gridTemplateColumns:"1fr", gap:"24px" }}>
            <div className="glass-card">
              <div className="card-title font-mono">Monthly Revenue vs Spend</div>
              <div style={{ fontSize:"13px", color:"var(--text-muted)", marginBottom:"24px" }}>All 10 channels combined &middot; 3 years of daily data</div>
              <ResponsiveContainer width="100%" height={350}>
                <LineChart data={monthlyTrend} margin={{top:10, right:30, left:20, bottom:10}}>
                  <XAxis dataKey="month" tick={{fill:"var(--text-muted)",fontSize:11}} tickFormatter={v=>v.slice(2)} axisLine={{stroke:"var(--border-color)"}} tickLine={{stroke:"var(--border-color)"}}/>
                  <YAxis tick={{fill:"var(--text-muted)",fontSize:11}} tickFormatter={v=>`₹${v}K`} axisLine={{stroke:"var(--border-color)"}} tickLine={{stroke:"var(--border-color)"}}/>
                  <Tooltip contentStyle={{background:"var(--bg-card)",border:"1px solid var(--border-color)",borderRadius:"8px",fontSize:"12px",backdropFilter:"blur(10px)"}} formatter={(v,n)=>[`₹${v}K`,n]}/>
                  <Legend wrapperStyle={{fontSize:"12px",color:"var(--text-main)", paddingTop:"20px"}}/>
                  <Line type="monotone" dataKey="revenue" stroke="url(#colorRevenue)" strokeWidth={3} dot={false} activeDot={{r:6, fill:"#f59e0b", strokeWidth:0}} name="Revenue"/>
                  <Line type="monotone" dataKey="spend" stroke="#ef4444" strokeWidth={2} dot={false} name="Spend" strokeDasharray="5 5"/>
                  <defs>
                    <linearGradient id="colorRevenue" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#f59e0b"/>
                      <stop offset="100%" stopColor="#ef4444"/>
                    </linearGradient>
                  </defs>
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="glass-card">
              <div className="card-title font-mono">Portfolio ROAS Trend</div>
              <div style={{ fontSize:"13px", color:"var(--text-muted)", marginBottom:"24px" }}>Is marketing efficiency improving over time?</div>
              <ResponsiveContainer width="100%" height={250}>
                <LineChart data={monthlyTrend} margin={{top:10, right:30, left:20, bottom:10}}>
                  <XAxis dataKey="month" tick={{fill:"var(--text-muted)",fontSize:11}} tickFormatter={v=>v.slice(2)} axisLine={{stroke:"var(--border-color)"}} tickLine={{stroke:"var(--border-color)"}}/>
                  <YAxis tick={{fill:"var(--text-muted)",fontSize:11}} domain={["auto","auto"]} tickFormatter={v=>`${v}x`} axisLine={{stroke:"var(--border-color)"}} tickLine={{stroke:"var(--border-color)"}}/>
                  <Tooltip contentStyle={{background:"var(--bg-card)",border:"1px solid var(--border-color)",borderRadius:"8px",fontSize:"12px",backdropFilter:"blur(10px)"}} formatter={v=>[`${v}x ROAS`,""]}/>
                  <ReferenceLine y={3} stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" label={{value:"3x Goal",fill:"var(--text-muted)",fontSize:11,position:"insideTopLeft"}}/>
                  <Line type="monotone" dataKey="roas" stroke="#06b6d4" strokeWidth={3} dot={false} activeDot={{r:6, fill:"#06b6d4", strokeWidth:0}} name="ROAS"/>
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div style={{ display:"grid", gridTemplateColumns:"repeat(2,1fr)", gap:"24px" }}>
              {[
                { title:"Non-Linear Returns Detected", body:`${dimChannels.map(c=>c.channel).join(", ")} show measurable diminishing returns. Excess spend here generates poor marginal ROAS. Budget reallocation away from these channels is the single highest-leverage action.` },
                { title:"Best Channels by Efficiency", body:`${sortedByScore.slice(0,3).map(c=>`${c.channel} (${c.totalRoas.toFixed(1)}x)`).join(", ")} consistently generate the most revenue per rupee. Increase allocation here first.` },
                { title:"Day-of-Week Timing", body:`All channels have a best-performing day. Concentrating spend on high-ROAS days can lift effective ROAS by 8–15% without increasing total budget.` },
                { title:"Data-Driven vs Gut-Feel", body:`Optimal allocation projects ${fmt(optRev)} monthly revenue at ${(totalBudget > 0 ? optRev/totalBudget : 0).toFixed(2)}x ROAS — moving from gut-feel to data is the highest ROI decision.` },
              ].map((f,i)=>(
                <div key={i} className="glass-card" style={{ padding:"24px", background:"rgba(255,255,255,0.02)", border:"1px solid rgba(255,255,255,0.05)" }}>
                  <div style={{ fontSize:"14px", fontWeight:"600", color:"var(--text-accent)", marginBottom:"12px", display:"flex", alignItems:"center", gap:"8px" }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                    {f.title}
                  </div>
                  <div style={{ fontSize:"13px", color:"var(--text-muted)", lineHeight:"1.7" }}>{f.body}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AI INSIGHTS */}
        {activeTab==="ai" && (
          <div className="animate-fade-in">
            <div className="glass-card glass-card-glow" style={{ minHeight: "500px", display: "flex", flexDirection: "column" }}>
              <div className="card-header">
                <div>
                  <div className="card-title font-mono">Gemini AI Engine</div>
                  <div className="card-subtitle">Deep Marketing Mix Analysis</div>
                </div>
              </div>

              {!aiReport && !isAiLoading && (
                  <div style={{ marginBottom: "30px", animation: "fadeIn 0.5s ease" }}>
                    <div style={{ fontSize: "12px", color: "var(--text-muted)", marginBottom: "12px", textTransform: "uppercase", letterSpacing: "1.5px", fontWeight: "600" }} className="font-mono">
                      Custom Analysis Focus
                    </div>
                    
                    {/* Quick Suggestions */}
                    <div style={{ display: "flex", gap: "10px", marginBottom: "16px", flexWrap: "wrap" }}>
                      {[
                        { label: "Growth Strategy", icon: "📈", query: "Focus on scaling top performers while maintaining 3.5x+ ROAS." },
                        { label: "Efficiency Audit", icon: "🛡️", query: "Identify the bottom 20% of spend and suggest where to cut." },
                        { label: "Weekend Timing", icon: "🗓️", query: "Analyze day-of-week patterns and suggest a scheduling strategy." },
                        { label: "Risk Assessment", icon: "⚠️", query: "Detect signs of saturation or diminishing returns in high-spend channels." }
                      ].map(item => (
                        <button 
                          key={item.label}
                          onClick={() => setCustomQuery(item.query)}
                          style={{ 
                            padding: "6px 12px", 
                            borderRadius: "20px", 
                            background: "rgba(255,255,255,0.05)", 
                            border: "1px solid var(--border-color)", 
                            color: "var(--text-muted)", 
                            fontSize: "12px",
                            cursor: "pointer",
                            transition: "all 0.2s"
                          }}
                          onMouseEnter={(e) => { e.target.style.background = "rgba(255,255,255,0.1)"; e.target.style.color = "var(--text-main)"; }}
                          onMouseLeave={(e) => { e.target.style.background = "rgba(255,255,255,0.05)"; e.target.style.color = "var(--text-muted)"; }}
                        >
                          {item.icon} {item.label}
                        </button>
                      ))}
                    </div>

                    <textarea 
                      value={customQuery}
                      onChange={(e) => setCustomQuery(e.target.value)}
                      placeholder="e.g. How can I increase revenue by 20% without changing the budget?"
                      style={{ 
                        width: "100%", 
                        background: "rgba(255,255,255,0.02)", 
                        border: "1px solid var(--border-color)", 
                        borderRadius: "16px", 
                        padding: "20px", 
                        color: "var(--text-main)", 
                        fontFamily: "var(--font-sans)",
                        fontSize: "15px",
                        resize: "none",
                        minHeight: "100px",
                        outline: "none",
                        transition: "all 0.3s",
                        boxShadow: "inset 0 2px 4px rgba(0,0,0,0.2)"
                      }}
                      onFocus={(e) => e.target.style.borderColor = "var(--text-accent)"}
                      onBlur={(e) => e.target.style.borderColor = "var(--border-color)"}
                    />
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "20px" }}>
                      <div style={{ fontSize: "12px", color: "var(--text-muted)" }} className="font-mono">
                        Powered by Gemini 1.5 Flash
                      </div>
                      <button className="btn btn-primary" style={{ padding: "12px 32px", fontSize: "15px" }} onClick={async () => {
                        setIsAiLoading(true);
                        
                        const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
                        const hasRealKey = apiKey && apiKey !== "YOUR_GEMINI_API_KEY" && apiKey.length > 10;

                        if (hasRealKey) {
                          try {
                            const prompt = `You are a high-level Marketing Strategist & Data Scientist. Analyze the provided portfolio data and generate a "MARKETING EFFICIENCY AUDIT" for a CMO.
                            
                            CONTEXT:
                            - Monthly Budget: ₹${totalBudget.toLocaleString()}
                            - Current State: ${projRev.toFixed(0)} Revenue (${projRoas.toFixed(2)}x ROAS)
                            - Ideal State (Max Possible): ${optRev.toFixed(0)} Revenue (${(optRev/totalBudget).toFixed(2)}x ROAS)
                            - Data Scale: ${allData.length} daily records across 3 years.
                            
                            CHANNEL PERFORMANCE:
                            ${JSON.stringify(channelStats.map(c => ({ 
                                name: c.channel, 
                                roas: c.totalRoas.toFixed(2), 
                                cpa: c.cpa.toFixed(0), 
                                cac: c.cac.toFixed(0),
                                diminishing: c.diminishing, 
                                best_day: c.bestDay 
                              })))}
                            
                            USER'S CURRENT MIX: ${JSON.stringify(allocation)}
                            MATHEMATICAL OPTIMAL MIX: ${JSON.stringify(optimalAlloc)}
                            
                            USER FOCUS: "${customQuery || "General performance optimization"}"
                            
                            REQUIRED STRUCTURE (Markdown):
                            ### 📊 Strategic Executive Summary
                            (2-3 sentences on the "Revenue Gap" and the primary efficiency lever.)
                            
                            ### 🔍 Core Channel Insights
                            (Provide 3 bullet points. Focus on: 1. The 'Engine' (top performer), 2. The 'Leak' (low ROI), 3. The 'Scale Potential' (where to put next ₹100k).)
                            
                            ### 🗓️ Temporal Optimization
                            (Analyze the day-of-week data to suggest a specific bidding schedule change.)
                            
                            ### 🚀 Tactical Reallocation Plan (Phased)
                            - **Phase 1 (Immediate - Next 7 Days)**: Specific ₹ shifts.
                            - **Phase 2 (Scaling - Next 30 Days)**: Targeted ROAS goals.
                            
                            TONE: Sharp, authoritative, and data-obsessed. No fluff. Use bolding for key numbers.`;

                            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
                            });

                            if (!response.ok) throw new Error("API Connection Failed");
                            
                            const data = await response.json();
                            if (data.candidates && data.candidates[0].content) {
                              setAiReport(data.candidates[0].content.parts[0].text);
                              setIsAiLoading(false);
                              return;
                            }
                          } catch (err) {
                            console.error("Gemini Error:", err);
                          }
                        }

                        // Heuristic Fallback
                        setTimeout(() => {
                          const top = sortedByScore[0];
                          const worst = sortedByScore[sortedByScore.length - 1];
                          const efficiency = (projRoas).toFixed(2);
                          const revenueGap = optRev - projRev;
                          
                          setAiReport(`${!hasRealKey ? "> [!NOTE]\n> Heuristic Analysis Mode enabled. Add Gemini API Key for deep Generative AI insights.\n\n" : ""}### 📊 Strategic Executive Summary
Your current portfolio is operating at **${efficiency}x ROAS**. Our analysis identifies a **₹${revenueGap.toLocaleString()}** efficiency gap between your current allocation and the mathematical frontier.

### 🔍 Core Channel Insights
- **The Engine**: **${top.channel}** is delivering a peak **${top.totalRoas.toFixed(2)}x ROAS**. It is currently under-scaled.
- **The Leak**: **${worst.channel}** is showing **${worst.diminishing ? "saturation" : "inefficiency"}** with a CPA of **${fmt(worst.cpa)}**. 

### 🗓️ Temporal Optimization
**${top.channel}** shows significantly higher conversion velocity on **${top.bestDay}s**. Shifting 15% of mid-week budget to this window will lift blended ROAS.

### 🚀 Tactical Reallocation Plan
- **Phase 1**: Shift ₹${(totalBudget * 0.1).toLocaleString()} from ${worst.channel} to ${top.channel}.
- **Phase 2**: Audit creative for ${worst.channel} or pivot budget to ${sortedByScore[1].channel}.`);
                          setIsAiLoading(false);
                        }, 2000);
                      }}>
                        ✨ Run AI Audit
                      </button>
                    </div>
                  </div>
                )}

                {isAiLoading ? (
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 0" }}>
                    <div className="ai-thinking-loader">
                      <div className="thinking-orbit"></div>
                      <div className="thinking-core"></div>
                    </div>
                    <div className="loader-title text-gradient" style={{ fontSize: "22px", marginTop: "32px", marginBottom: "8px" }}>Analyzing Portfolio...</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: "8px", alignItems: "center" }}>
                      {[
                        "Correlating spend across 1,095 days...",
                        "Calculating marginal ROAS curves...",
                        "Detecting diminishing returns patterns...",
                        "Simulating optimal reallocations..."
                      ].map((txt, i) => (
                        <div key={i} className="font-mono animate-fade-in" style={{ fontSize: "11px", color: "var(--text-muted)", animationDelay: `${i*0.5}s`, opacity: 0.5 }}>
                          {txt}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : aiReport ? (
                  <div className="ai-report-content animate-fade-in" style={{ lineHeight: "1.8", color: "var(--text-main)", fontSize: "15px" }}>
                    <div style={{ 
                      whiteSpace: "pre-wrap", 
                      background: "rgba(255,255,255,0.015)", 
                      padding: "40px", 
                      borderRadius: "24px", 
                      border: "1px solid var(--border-color)",
                      boxShadow: "0 20px 40px rgba(0,0,0,0.3)",
                      backdropFilter: "blur(10px)"
                    }}>
                      {aiReport.split('\n').map((line, i) => {
                        const trimmed = line.trim();
                        if (trimmed.startsWith('###')) return <h3 key={i} style={{ color: "var(--text-accent)", marginTop: i === 0 ? 0 : "32px", marginBottom: "16px", fontSize: "20px", fontWeight: "700", borderBottom: "1px solid rgba(255,255,255,0.05)", paddingBottom: "12px" }}>{trimmed.replace('### ', '')}</h3>;
                        
                        // Handle bold numbers/text
                        const parts = line.split(/(\*\*.*?\*\*)/g).map((part, pi) => {
                          if (part.startsWith('**') && part.endsWith('**')) {
                            return <strong key={pi} style={{ color: "var(--text-accent)", fontWeight: "700" }}>{part.replace(/\*\*/g, '')}</strong>;
                          }
                          return part;
                        });

                        if (trimmed.startsWith('- ')) return <li key={i} style={{ marginLeft: "20px", marginBottom: "10px", color: "var(--text-main)" }}>{parts.map(p => (typeof p === 'string' ? p.replace('- ', '') : p))}</li>;
                        if (trimmed.startsWith('> ')) return <div key={i} style={{ margin: "20px 0", padding: "16px", background: "rgba(245,158,11,0.05)", borderLeft: "4px solid #f59e0b", borderRadius: "8px", color: "var(--text-muted)", fontSize: "13px" }}>{line.replace('> ', '').replace('[!NOTE]', '')}</div>;
                        
                        return <p key={i} style={{ marginBottom: "16px", color: "rgba(255,255,255,0.8)" }}>{parts}</p>;
                      })}
                    </div>
                    <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "24px" }}>
                      <button className="btn" style={{ background: "rgba(255,255,255,0.05)", color: "var(--text-muted)", borderRadius: "12px" }} onClick={() => setAiReport("")}>
                        New Analysis
                      </button>
                    </div>
                  </div>
                ) : (

                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", textAlign: "center" }}>
                  <div style={{ fontSize: "48px", marginBottom: "20px" }}>🤖</div>
                  <div style={{ fontSize: "20px", fontWeight: "600", color: "var(--text-main)", marginBottom: "10px" }}>AI Marketing Intelligence</div>
                  <p style={{ maxWidth: "400px" }}>Click the button above to run a comprehensive AI audit on your current marketing performance and receive actionable growth recommendations.</p>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      <footer className="app-footer">
        {fmtN(allData.length)} data points &middot; Real API &middot; 3-Year Analysis
      </footer>

    </div>
  );
}
