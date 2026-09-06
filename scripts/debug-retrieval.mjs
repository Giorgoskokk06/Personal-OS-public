#!/usr/bin/env node
import { getOwner, loadEnv, normalizeKey, requiredEnv, SupabaseRest } from "./lib.mjs";

loadEnv();
const rawArgs = process.argv.slice(2);
const profileFlag = rawArgs.includes("--profile");
const deepFlag = rawArgs.includes("--deep") || profileFlag;
const query = rawArgs.filter((arg) => !arg.startsWith("--")).join(" ").trim();
if (!query && !profileFlag) {
  console.error('Usage: npm run debug:retrieval -- "<query>" [--deep]');
  console.error('   or: npm run debug:retrieval -- --profile');
  process.exit(1);
}

function padded(text) { return ` ${normalizeKey(text)} `; }
function hasPhrase(text, phrase) { const p = normalizeKey(phrase); return p.length > 1 && padded(text).includes(` ${p} `); }
function anyPhrase(text, phrases) { return phrases.some((p) => hasPhrase(text, p)); }
function detectDomains(text) {
  const domains = new Set();
  if (anyPhrase(text, ["dating","romantic","romance","flirt","date","dates","dating history","ραντεβου","κοπελα","κοπελες","φλερτ","ερωτικα","ερωτικη","ερωτικο"])) { domains.add("dating"); domains.add("relationships"); }
  if (anyPhrase(text, ["relationship","relationships","σχεση","σχεσεις","πατερας","πατερα","father","family","οικογενεια"])) domains.add("relationships");
  if (anyPhrase(text, ["career","job","work","δουλεια","εργασια","καριερα","ρολος","ρολο"])) { domains.add("career"); domains.add("work"); }
  if (anyPhrase(text, ["learning","learn","sql","python","typescript","git","testing","swe","μαθηση","δεξιοτητα","δεξιοτητες","τεχνικη","τεχνικο"])) domains.add("learning");
  if (anyPhrase(text, ["university","exam","exams","course","πανεπιστημιο","σχολη","εξεταση","εξετασεις","μαθημα"])) domains.add("university");
  if (anyPhrase(text, ["health","medical","doctor","cardiology","υγεια","γιατρος","γιατρο","εξετασεις αιματος"])) domains.add("health");
  if (anyPhrase(text, ["fitness","gym","running","marathon","long run","training plan","γυμναστηριο","τρεξιμο","μαραθωνιος","προπονηση"])) domains.add("fitness");
  if (anyPhrase(text, ["finance","financial","money","salary","budget","reoco","οικονομικα","χρηματα","μισθος","σπιτι"])) domains.add("finance");
  if (anyPhrase(text, ["personal os","supabase","telegram bot","retrieval","router","webhook","pgvector","edge function","model routing"])) { domains.add("system"); domains.add("personal_os"); }
  return [...domains];
}
function requiredDomains(text, domains) {
  if (anyPhrase(text, ["dating","dating history","romantic","romance","flirt","ραντεβου","κοπελα","κοπελες","φλερτ","ερωτικα"])) return ["dating"];
  if (domains.includes("health") && !domains.includes("fitness")) return ["health"];
  if (domains.includes("fitness") && !domains.includes("health")) return ["fitness"];
  if (domains.includes("university")) return ["university"];
  if (domains.includes("finance")) return ["finance"];
  if (domains.includes("system")) return ["system", "personal_os"];
  if (domains.includes("career") || domains.includes("work")) return ["career", "work"];
  return [];
}
function expand(text, domains) {
  const a = [];
  if (domains.includes("dating")) a.push("dating romantic relationship ραντεβού κοπέλα φλερτ");
  else if (domains.includes("relationships")) a.push("relationship relationships σχέση σχέσεις family father πατέρας");
  if (domains.includes("career") || domains.includes("work")) a.push("career work job role δουλειά εργασία καριέρα");
  if (domains.includes("learning")) a.push("learning skill technical swe μάθηση δεξιότητα");
  if (domains.includes("university")) a.push("university exam course πανεπιστήμιο εξέταση μάθημα");
  if (domains.includes("health")) a.push("health medical υγεία");
  if (domains.includes("fitness")) a.push("fitness training running marathon προπόνηση");
  if (domains.includes("finance")) a.push("finance money salary budget οικονομικά");
  if (domains.includes("system")) a.push("personal os retrieval router database telegram supabase");
  return [text.trim(), ...a].filter(Boolean).join(" | ");
}
function broad(text) {
  const n = normalizeKey(text);
  return ["τι ξερεις για μενα","τι θυμασαι για μενα","what do you know about me","what do you remember about me","με βαση ολα οσα ξερεις","ολη την ιστορια μου","ολο το ιστορικο","ολα τα δεδομενα"].some((x) => n.includes(normalizeKey(x)));
}

const rest = new SupabaseRest(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
const owner = await getOwner(rest);
const domains = detectDomains(query);
const required = requiredDomains(query, domains);
const isBroad = profileFlag || broad(query);
const strict = required.length > 0 && !isBroad;
const expanded = expand(query, domains);

const allEntities = await rest.select("memory_entities", { user_id: `eq.${owner.id}`, status: "eq.active", select: "id,entity_type,canonical_name,normalized_key,aliases,domains", limit: 1000 }).catch(() => []);
const q = padded(query);
const resolved = allEntities.filter((e) => [e.canonical_name, ...(e.aliases || [])].some((alias) => {
  const n = normalizeKey(alias); return n.length >= 2 && q.includes(` ${n} `);
}));
const entityIds = resolved.map((e) => e.id);
const includeDeep = deepFlag || isBroad || entityIds.length > 0;

console.log("Query:", query || "(profile only)");
console.log("Domain hints:", domains.length ? domains.join(", ") : "(none)");
console.log("Required domains:", required.length ? required.join(", ") : "(none)");
console.log("Strict domain gating:", strict);
console.log("Resolved entities:", resolved.length ? resolved.map((e) => `${e.canonical_name} <${e.entity_type}>`).join(", ") : "(none)");
console.log("Deep historical evidence:", includeDeep);
console.log("Expanded lexical query:", expanded || "(none)");

if (query) {
  const { data: recordData } = await rest.request("rpc/match_records_hybrid_v4", {
    method: "POST",
    body: { p_user_id: owner.id, p_query_text: expanded, p_query_embedding: null, p_domain_hints: domains, p_required_domains: required, p_entity_ids: entityIds, p_strict_domain: strict, p_match_count: deepFlag ? 40 : 30, p_min_similarity: 0.18 },
  });
  const records = Array.isArray(recordData) ? recordData : [];
  console.log(`\nRecord retrieval v4: ${records.length}`);
  console.table(records.map((row) => ({ type: row.record_type, title: row.title, domains: (row.domains || []).join(","), score: Number(row.score || 0).toFixed(3), lexical: Number(row.lexical_score || 0).toFixed(3), entity_link: Number(row.entity_link_score || 0).toFixed(3), domain: Number(row.domain_score || 0).toFixed(3), status: row.status })));

  const { data: chunkData } = await rest.request("rpc/match_source_chunks_hybrid_v4", {
    method: "POST",
    body: { p_user_id: owner.id, p_query_text: expanded, p_query_embedding: null, p_domain_hints: domains, p_required_domains: required, p_entity_ids: entityIds, p_strict_domain: strict, p_include_deep_scope: includeDeep, p_match_count: deepFlag ? 20 : 10, p_min_similarity: 0.18 },
  });
  const chunks = Array.isArray(chunkData) ? chunkData : [];
  console.log(`\nSource evidence v4: ${chunks.length}`);
  console.table(chunks.map((row) => ({ document: row.document_title, role: row.source_role, scope: row.retrieval_scope, domains: (row.domains || []).join(","), occurred_at: row.occurred_at || "", score: Number(row.score || 0).toFixed(3), preview: String(row.content || "").replace(/\s+/g, " ").slice(0, 120) })));
}

if (isBroad) {
  const { data } = await rest.request("rpc/profile_records_v2", { method: "POST", body: { p_user_id: owner.id, p_match_count: 36, p_per_facet: deepFlag ? 4 : 3 } });
  const rows = Array.isArray(data) ? data : [];
  console.log(`\nDiversified profile v2: ${rows.length}`);
  console.table(rows.map((row) => ({ type: row.record_type, title: row.title, domains: (row.domains || []).join(","), score: Number(row.score || 0).toFixed(3), fact_state: row.fact_state, knowledge: row.knowledge_status })));
  const { data: historyData } = await rest.request("rpc/profile_source_chunks_v1", { method: "POST", body: { p_user_id: owner.id, p_match_count: 16, p_per_facet: 3 } });
  const history = Array.isArray(historyData) ? historyData : [];
  console.log(`\nDiversified historical user evidence: ${history.length}`);
  console.table(history.map((row) => ({ document: row.document_title, domains: (row.domains || []).join(","), occurred_at: row.occurred_at || "", score: Number(row.score || 0).toFixed(3), preview: String(row.content || "").replace(/\s+/g, " ").slice(0, 120) })));
}
