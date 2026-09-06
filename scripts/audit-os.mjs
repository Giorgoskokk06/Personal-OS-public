#!/usr/bin/env node
import fs from "node:fs";
import { getOwner, loadEnv, requiredEnv, SupabaseRest } from "./lib.mjs";

loadEnv();
const rest = new SupabaseRest(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
const owner = await getOwner(rest);

const args = process.argv.slice(2);
const jsonArg = args.find((arg) => arg.startsWith("--json="));
const customTerms = args.filter((arg) => !arg.startsWith("--"));
const configuredTerms = String(process.env.PERSONAL_OS_AUDIT_TERMS ?? "")
  .split(",")
  .map((term) => term.trim())
  .filter(Boolean);
const searchTerms = customTerms.length
  ? customTerms
  : (configuredTerms.length ? configuredTerms : ["career", "learning", "personal os"]);
const staleDateTerms = String(process.env.PERSONAL_OS_STALE_DATE_TERMS ?? "")
  .split(",")
  .map((term) => term.trim().toLocaleLowerCase("el-GR"))
  .filter(Boolean);

const records = await rest.select("records", {
  user_id: `eq.${owner.id}`,
  select: "id,record_type,domains,title,body,status,fact_state,knowledge_status,confidence,importance,authority_level,canonical_key,data,embedding_model,created_at,updated_at",
  limit: 2000,
});
const sources = await rest.select("source_documents", {
  user_id: `eq.${owner.id}`,
  select: "id,title,source_type,sensitivity,authority_level,original_filename,created_at",
  limit: 1000,
});
const stateRows = await rest.select("current_state", {
  user_id: `eq.${owner.id}`,
  coach_key: "eq.default",
  select: "*",
  limit: 1,
});
const routeState = await rest.select("model_route_state", {
  select: "provider,model,circuit_state,blocked_until,last_error_kind,last_error_at,last_success_at,consecutive_failures",
  limit: 100,
}).catch(() => []);

function countBy(items, keyFn) {
  const out = {};
  for (const item of items) {
    const keys = keyFn(item);
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const k = key || "(none)";
      out[k] = (out[k] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

function compactRecord(record) {
  return {
    id: record.id,
    type: record.record_type,
    title: record.title,
    domains: record.domains,
    status: record.status,
    fact_state: record.fact_state,
    knowledge_status: record.knowledge_status,
    canonical_key: record.canonical_key,
    embedding: Boolean(record.embedding_model),
  };
}

const termMatches = {};
for (const term of searchTerms) {
  const needle = term.toLocaleLowerCase("el-GR");
  termMatches[term] = records
    .filter((record) => {
      const haystack = [record.title, record.body, JSON.stringify(record.data ?? {})].join(" ").toLocaleLowerCase("el-GR");
      return haystack.includes(needle);
    })
    .map(compactRecord);
}

const state = stateRows[0] ?? null;
const stateText = JSON.stringify(state ?? {}).toLocaleLowerCase("el-GR");
const warnings = [];
if (!records.length) warnings.push("NO_RECORDS: public.records has no rows for the owner.");
if (!sources.length) warnings.push("NO_SOURCES: no source_documents found for the owner.");
if (!records.some((r) => (r.domains ?? []).some((d) => ["dating", "relationships"].includes(d)))) {
  warnings.push("NO_RELATIONSHIP_DOMAIN: no records tagged dating/relationships were found.");
}
if (!records.some((r) => (r.domains ?? []).some((d) => ["career", "work"].includes(d)))) {
  warnings.push("NO_CAREER_DOMAIN: no career/work records were found.");
}
if (staleDateTerms.some((term) => stateText.includes(term))) {
  warnings.push("STALE_CURRENT_STATE_DATE: current_state contains a configured stale date. Review it before trusting hot context.");
}
if (staleDateTerms.some((term) => records.some((record) => {
  const text = [record.title, record.body, JSON.stringify(record.data ?? {})].join(" ").toLocaleLowerCase("el-GR");
  return text.includes(term);
}))) {
  warnings.push("POSSIBLE_STALE_RECORD_DATE: one or more canonical records contain a configured stale date.");
}

const report = {
  owner: { id: owner.id, display_name: owner.display_name },
  totals: {
    records: records.length,
    source_documents: sources.length,
    embedded_records: records.filter((r) => r.embedding_model).length,
    unembedded_records: records.filter((r) => !r.embedding_model).length,
  },
  by_record_type: countBy(records, (r) => r.record_type),
  by_domain: countBy(records, (r) => r.domains ?? []),
  by_status: countBy(records, (r) => r.status),
  by_knowledge_status: countBy(records, (r) => r.knowledge_status),
  source_types: countBy(sources, (s) => s.source_type),
  source_sensitivity: countBy(sources, (s) => s.sensitivity),
  current_state: state,
  model_route_state: routeState,
  term_matches: termMatches,
  warnings,
};

console.log(`Owner: ${owner.display_name || owner.id}`);
console.log(`Records: ${report.totals.records} (${report.totals.embedded_records} embedded / ${report.totals.unembedded_records} no-embed)`);
console.log(`Source documents: ${report.totals.source_documents}`);
console.log("\nRecords by type:");
console.table(Object.entries(report.by_record_type).map(([type, count]) => ({ type, count })));
console.log("\nRecords by domain:");
console.table(Object.entries(report.by_domain).map(([domain, count]) => ({ domain, count })));
console.log("\nCurrent state:");
console.dir(state, { depth: 5 });

for (const term of searchTerms) {
  console.log(`\nMatches for ${JSON.stringify(term)}: ${termMatches[term].length}`);
  console.table(termMatches[term].slice(0, 25).map((r) => ({
    type: r.type,
    title: r.title,
    domains: (r.domains ?? []).join(","),
    status: r.status,
    fact_state: r.fact_state,
    knowledge: r.knowledge_status,
    embedded: r.embedding,
  })));
}

if (warnings.length) {
  console.log("\nWARNINGS:");
  for (const warning of warnings) console.log(`- ${warning}`);
} else {
  console.log("\nNo obvious structural/data-quality warnings from this audit.");
}

if (jsonArg) {
  const file = jsonArg.slice("--json=".length);
  fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log(`\nJSON report written to ${file}`);
}
