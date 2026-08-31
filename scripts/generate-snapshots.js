#!/usr/bin/env node
/**
 * TSDG — Snapshots de Tráfego Pago
 * Roda diariamente via GitHub Actions e commita os JSONs no próprio repo.
 * Netlify (conectado ao repo) serve os arquivos como estático.
 *
 * Requisitos: Node 20+ (fetch nativo). Sem dependências externas.
 *
 * Uso local:
 *   node scripts/generate-snapshots.js
 *
 * Uso no CI: chamado pelo .github/workflows/snapshots.yml
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// ============================================================
// CONFIG — editar quando entrar/sair conta
// ============================================================
const PROXY_URL = "https://dash-trafego-pago.netlify.app/api/meta";

const ACCOUNTS = [
  // ── HAIR (14 contas ativas — Terra do Beija Flor pausada, fora daqui)
  { name: "BIOMA Brisa",           id: "act_787511457358450",  segment: "HAIR",  template: "HAIR" },
  { name: "BIOMA Casa 631",        id: "act_1745103243320903", segment: "HAIR",  template: "HAIR" },
  { name: "BIOMA Casa Fio",        id: "act_848058778028078",  segment: "HAIR",  template: "HAIR" },
  { name: "BIOMA Elizete Corrêa",  id: "act_2353518435060586", segment: "HAIR",  template: "HAIR" },
  { name: "BIOMA Jackeline",       id: "act_1778995386836575", segment: "HAIR",  template: "HAIR" },
  { name: "BIOMA Paixão",          id: "act_1425536086084105", segment: "HAIR",  template: "HAIR" },
  { name: "BIOMA Sense",           id: "act_744052467983233",  segment: "HAIR",  template: "HAIR" },
  { name: "BIOMA Silvio Amaral",   id: "act_919673088419931",  segment: "HAIR",  template: "HAIR" },
  { name: "BIOMA Uberaba",         id: "act_1761413471046706", segment: "HAIR",  template: "HAIR" },
  { name: "BIOMA Valéria Alleoni", id: "act_166071522",        segment: "HAIR",  template: "HAIR" },
  { name: "BIOMA Yu Tin Tin",      id: "act_1073344743202770", segment: "HAIR",  template: "HAIR" },
  { name: "LACES Origens",         id: "act_1377904143357140", segment: "HAIR",  template: "HAIR" },
  { name: "MORINGA Hair",          id: "act_1813229102959243", segment: "HAIR",  template: "HAIR" },
  { name: "MORINGA Barber",        id: "act_766430752620913",  segment: "HAIR",  template: "HAIR" },
  // ── LASER
  { name: "Espaçolaser Bragança",  id: "act_806895401401781",  segment: "LASER", template: "LASER" },
  { name: "Espaçolaser Caçapava",  id: "act_1495147508059741", segment: "LASER", template: "LASER" },
  { name: "Espaçolaser Campolim",  id: "act_431873056620839",  segment: "LASER", template: "LASER" },
  // ── TECH
  { name: "VIRGO Cases",           id: "act_896596526559885",  segment: "TECH",  template: "VIRGO" },
  { name: "MIMO Live Sales",       id: "act_1365837951918266", segment: "TECH",  template: "MIMO" },
];

// Durante shadow mode: salvar resposta bruta pra tunar o flatten
const SAVE_RAW = true;

// ============================================================
// MAIN
// ============================================================
async function main() {
  const startedAt = Date.now();
  const dates = computeDateWindows();

  console.log(`▶ Snapshot run — ${dates.today}`);
  console.log(`  current:  ${dates.current.since} → ${dates.current.until}`);
  console.log(`  previous: ${dates.previous.since} → ${dates.previous.until}`);
  console.log(`  accounts: ${ACCOUNTS.length}\n`);

  const results = await Promise.allSettled(
    ACCOUNTS.map((acc) => processAccount(acc, dates))
  );

  const summary = compileSummary(results, dates, startedAt);
  await writeJson(`snapshots/runs/${dates.today}.json`, summary);

  console.log(`\n✓ Done in ${summary.duration_ms}ms — ${summary.ok}/${summary.total} OK` +
              (summary.partial ? `, ${summary.partial} partial` : "") +
              (summary.failed ? `, ${summary.failed} failed` : ""));

  if (summary.failures.length) {
    console.log("\nFailures:");
    summary.failures.forEach((f) => console.log(`  ✗ ${f.name}: ${f.reason}`));
  }
}

async function processAccount(account, dates) {
  const notes = [];
  let currentRaw = null;
  let previousRaw = null;
  let fetchStatus = "ok";

  try {
    const [curRes, prevRes] = await Promise.allSettled([
      fetchProxy(account.id, dates.current.since, dates.current.until),
      fetchProxy(account.id, dates.previous.since, dates.previous.until),
    ]);

    if (curRes.status === "fulfilled") currentRaw = curRes.value;
    else { notes.push(`current: ${curRes.reason?.message || curRes.reason}`); fetchStatus = "partial"; }

    if (prevRes.status === "fulfilled") previousRaw = prevRes.value;
    else { notes.push(`previous: ${prevRes.reason?.message || prevRes.reason}`); fetchStatus = fetchStatus === "partial" ? "failed" : "partial"; }

    if (!currentRaw && !previousRaw) fetchStatus = "failed";
  } catch (e) {
    notes.push(`unexpected: ${e.message || e}`);
    fetchStatus = "failed";
  }

  const snapshot = buildSnapshot(account, dates, currentRaw, previousRaw, fetchStatus, notes);
  const key = `${account.id}.json`;

  await Promise.all([
    writeJson(`snapshots/latest/${key}`, snapshot),
    writeJson(`snapshots/history/${dates.today}/${key}`, snapshot),
    SAVE_RAW && (currentRaw || previousRaw)
      ? writeJson(`snapshots/raw/${dates.today}/${account.id}.json`, { current: currentRaw, previous: previousRaw })
      : Promise.resolve(),
  ]);

  const emoji = fetchStatus === "ok" ? "✓" : fetchStatus === "partial" ? "◐" : "✗";
  console.log(`  ${emoji} ${account.name.padEnd(25)} ${account.id}`);

  return snapshot.meta;
}

// ============================================================
// SNAPSHOT BUILDER (flatten defensivo)
// ============================================================
function buildSnapshot(account, dates, currentRaw, previousRaw, fetchStatus, notes) {
  const cur = extractMetrics(currentRaw);
  const prev = extractMetrics(previousRaw);

  const totals = {
    spend:       deltaBlock(cur.spend, prev.spend),
    impressions: deltaBlock(cur.impressions, prev.impressions),
    reach:       deltaBlock(cur.reach, prev.reach),
    clicks:      deltaBlock(cur.clicks, prev.clicks),
    ctr:         deltaBlock(cur.ctr, prev.ctr),
    cpc:         deltaBlock(cur.cpc, prev.cpc),
    thruplay:    deltaBlock(cur.thruplay, prev.thruplay),
    frequency:   deltaBlock(cur.frequency, prev.frequency),
  };

  const conversions = {
    whatsapp_messages: convBlock(cur.messages, prev.messages, cur.cost_per_message, prev.cost_per_message, cur.top_creative_messages),
    instagram_visits:  convBlock(cur.ig_visits, prev.ig_visits, cur.cost_per_ig_visit, prev.cost_per_ig_visit, cur.top_creative_ig),
    site_visits:       account.template === "VIRGO" ? convBlock(cur.site_visits, prev.site_visits, cur.cost_per_site_visit, prev.cost_per_site_visit, cur.top_creative_site) : null,
    site_purchases:    account.template === "VIRGO" ? purchaseBlock(cur.purchases, prev.purchases, cur.revenue, cur.spend) : null,
  };

  const autoFlags = computeAutoFlags(totals, conversions, cur);

  return {
    meta: {
      account_id: account.id,
      account_name: account.name,
      segment: account.segment,
      template: account.template,
      generated_at: new Date().toISOString(),
      fetch_status: fetchStatus,
      fetch_source: "github_actions",
      notes,
    },
    period: {
      current: { ...dates.current },
      previous: { ...dates.previous },
    },
    totals,
    conversions,
    top_creatives: extractTopCreatives(currentRaw),
    demographics: extractDemographics(currentRaw),
    campaigns_active: extractCampaigns(currentRaw),
    account_health: extractHealth(currentRaw),
    auto_flags: autoFlags,
  };
}

// ============================================================
// EXTRAÇÃO — tolerante, retorna null se não achar
// ============================================================
function extractMetrics(raw) {
  if (!raw) return {};
  const t = raw.totals || raw.summary || raw.aggregate || raw;
  return {
    spend:       num(t.spend ?? t.investimento ?? t.cost),
    impressions: num(t.impressions ?? t.impressoes ?? t.impressao),
    reach:       num(t.reach ?? t.alcance),
    clicks:      num(t.clicks ?? t.cliques ?? t.link_clicks),
    ctr:         num(t.ctr),
    cpc:         num(t.cpc),
    thruplay:    num(t.thruplay ?? t.thru_play ?? t.video_thruplay_watched_actions),
    frequency:   num(t.frequency ?? t.frequencia),
    messages:    num(t.messages ?? t.conversas ?? t.onsite_conversion_messaging_conversation_started_7d),
    cost_per_message: num(t.cost_per_message ?? t.custo_por_conversa),
    ig_visits:   num(t.ig_visits ?? t.instagram_visits ?? t.visitas_instagram ?? t.profile_visit),
    cost_per_ig_visit: num(t.cost_per_ig_visit ?? t.custo_por_visita_ig),
    site_visits: num(t.site_visits ?? t.landing_page_views ?? t.visitas_site),
    cost_per_site_visit: num(t.cost_per_site_visit ?? t.custo_por_visita_site),
    purchases:   num(t.purchases ?? t.compras ?? t.omni_purchase),
    revenue:     num(t.revenue ?? t.receita ?? t.purchase_value),
    top_creative_messages: extractTopCreative(raw, "messages"),
    top_creative_ig:       extractTopCreative(raw, "ig_visits"),
    top_creative_site:     extractTopCreative(raw, "site_visits"),
  };
}

function extractTopCreative(raw, metric) {
  const ads = raw?.ads || raw?.creatives || raw?.top_ads || [];
  if (!Array.isArray(ads) || ads.length === 0) return null;
  const keys = metric === "messages" ? ["messages", "conversas"]
             : metric === "ig_visits" ? ["ig_visits", "visitas_instagram", "profile_visit"]
             : metric === "site_visits" ? ["site_visits", "landing_page_views"]
             : [metric];
  let best = null;
  for (const ad of ads) {
    const v = firstDefined(ad, keys);
    if (v == null) continue;
    if (!best || v > best.value) best = { name: ad.name || ad.creative_name || ad.ad_name || "sem nome", value: num(v) };
  }
  return best;
}

function extractTopCreatives(raw) {
  const ads = raw?.ads || raw?.creatives || raw?.top_ads || [];
  if (!Array.isArray(ads)) return [];
  return ads.slice(0, 10).map((ad) => ({
    name: ad.name || ad.creative_name || ad.ad_name || "sem nome",
    impressions: num(ad.impressions ?? ad.impressoes),
    reach: num(ad.reach ?? ad.alcance),
    clicks: num(ad.clicks ?? ad.cliques),
    messages: num(ad.messages ?? ad.conversas),
    ctr: num(ad.ctr),
    thruplay: num(ad.thruplay ?? ad.thru_play),
  }));
}

function extractDemographics(raw) {
  const demo = raw?.demographics || raw?.demografia || null;
  if (!demo) return null;
  return {
    gender: demo.gender || demo.genero || null,
    age: demo.age || demo.idade || null,
  };
}

function extractCampaigns(raw) {
  const camps = raw?.campaigns || raw?.campanhas || [];
  if (!Array.isArray(camps)) return [];
  return camps
    .filter((c) => (c.status || "").toUpperCase() === "ACTIVE" || c.active === true)
    .slice(0, 20)
    .map((c) => ({
      name: c.name || c.campaign_name || "sem nome",
      objective: c.objective || null,
      spend: num(c.spend ?? c.investimento),
      status: c.status || (c.active ? "ACTIVE" : null),
    }));
}

function extractHealth(raw) {
  const h = raw?.account || raw?.account_health || raw?.health || {};
  const balanceCents = num(h.balance);
  const balanceBrl = balanceCents ? balanceCents / 100 : null;
  return {
    balance_brl: balanceBrl,
    balance_low: false,
    account_disabled: h.disable_reason != null && h.disable_reason !== 0,
  };
}

// ============================================================
// HELPERS
// ============================================================
function deltaBlock(current, previous) {
  return { current: current ?? null, previous: previous ?? null, delta_pct: deltaPct(current, previous) };
}

function convBlock(curCount, prevCount, curCost, prevCost, topCreative) {
  return { count: deltaBlock(curCount, prevCount), cost: deltaBlock(curCost, prevCost), top_creative: topCreative };
}

function purchaseBlock(count, prevCount, revenue, spend) {
  return {
    count: deltaBlock(count, prevCount),
    revenue,
    roi: (revenue && spend) ? +(revenue / spend).toFixed(2) : null,
  };
}

function deltaPct(current, previous) {
  if (current == null || previous == null) return null;
  if (previous === 0 && current === 0) return 0;
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function computeAutoFlags(totals, conversions, cur) {
  const flags = [];
  if (Math.abs(totals.spend.delta_pct ?? 0) > 50) flags.push("spend_delta_over_50");
  if (conversions.whatsapp_messages?.count?.current === 0) flags.push("zero_conversations_current");
  const topMsg = conversions.whatsapp_messages?.top_creative?.value;
  const totalMsg = conversions.whatsapp_messages?.count?.current;
  if (topMsg && totalMsg && (topMsg / totalMsg) > 0.8) flags.push("creative_concentration_over_80");
  return flags;
}

async function fetchProxy(accountId, since, until) {
  const url = `${PROXY_URL}?method=getAccountData&account_id=${accountId}&period=custom&since=${since}&until=${until}`;
  const res = await fetch(url, { headers: { "accept": "application/json" } });
  if (!res.ok) throw new Error(`proxy ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`proxy error: ${JSON.stringify(data.error).slice(0, 100)}`);
  return data;
}

function computeDateWindows() {
  const now = new Date();
  const brtOffsetMs = 3 * 60 * 60 * 1000;
  const nowBrt = new Date(now.getTime() - brtOffsetMs);
  const todayBrt = ymd(nowBrt);
  const yesterday = new Date(nowBrt); yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const curUntil = ymd(yesterday);
  const curSince = ymd(shift(yesterday, -6));
  const prevUntil = ymd(shift(yesterday, -7));
  const prevSince = ymd(shift(yesterday, -13));
  return {
    today: todayBrt,
    current: { since: curSince, until: curUntil, label_pt: labelPt(curSince, curUntil) },
    previous: { since: prevSince, until: prevUntil },
  };
}

function ymd(d) { return d.toISOString().slice(0, 10); }
function shift(d, days) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + days); return x; }
function labelPt(since, until) {
  const meses = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
  const s = new Date(since + "T00:00:00Z"); const u = new Date(until + "T00:00:00Z");
  return `${s.getUTCDate()} ${meses[s.getUTCMonth()]} a ${u.getUTCDate()} ${meses[u.getUTCMonth()]}`;
}

function num(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "string" ? parseFloat(v.replace(",", ".")) : Number(v);
  return Number.isFinite(n) ? n : null;
}

function firstDefined(obj, keys) { for (const k of keys) if (obj[k] != null) return obj[k]; return null; }

async function writeJson(relPath, obj) {
  await mkdir(dirname(relPath), { recursive: true });
  await writeFile(relPath, JSON.stringify(obj, null, 2), "utf8");
}

function compileSummary(results, dates, startedAt) {
  const summary = {
    started_at: new Date(startedAt).toISOString(),
    duration_ms: Date.now() - startedAt,
    dates,
    total: ACCOUNTS.length,
    ok: 0, partial: 0, failed: 0,
    failures: [],
  };
  results.forEach((r, i) => {
    const acc = ACCOUNTS[i];
    if (r.status === "fulfilled") {
      const status = r.value.fetch_status;
      summary[status]++;
      if (status !== "ok") summary.failures.push({ id: acc.id, name: acc.name, reason: r.value.notes?.[0] });
    } else {
      summary.failed++;
      summary.failures.push({ id: acc.id, name: acc.name, reason: String(r.reason).slice(0, 200) });
    }
  });
  return summary;
}

main().catch((e) => { console.error(e); process.exit(1); });
