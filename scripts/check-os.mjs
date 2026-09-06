#!/usr/bin/env node
import { getOwner, loadEnv, requiredEnv, SupabaseRest } from "./lib.mjs";

loadEnv();
const url = requiredEnv("SUPABASE_URL");
const rest = new SupabaseRest(url, requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
const owner = await getOwner(rest);
const healthQuery = String(process.env.PERSONAL_OS_HEALTH_QUERY ?? "personal os").trim() || "personal os";

const checks = [];
async function check(name, fn) {
  try {
    const detail = await fn();
    checks.push({ name, ok: true, detail });
  } catch (error) {
    checks.push({ name, ok: false, detail: String(error?.message || error) });
  }
}

await check("database/users", async () => `owner=${owner.id}`);

for (const table of [
  "records",
  "messages",
  "source_documents",
  "source_chunks",
  "current_state",
  "ingress_events",
  "model_runs",
  "model_route_state",
  "provider_route_state",
  "current_state_history",
  "memory_entities",
  "record_entities",
  "source_chunk_entities",
]) {
  await check(`table/${table}`, async () => {
    const selectByTable = {
      model_route_state: "provider,model",
      provider_route_state: "provider",
      record_entities: "record_id,entity_id,relation_type",
      source_chunk_entities: "source_chunk_id,entity_id,relation_type",
    };

    const query = {
      select: selectByTable[table] || "id",
      limit: 5,
    };

    if ([
      "records",
      "messages",
      "source_documents",
      "current_state",
      "ingress_events",
      "model_runs",
      "current_state_history",
      "memory_entities",
    ].includes(table)) {
      query.user_id = `eq.${owner.id}`;
    }
    const { data } = await rest.request(table, { query });
    return `reachable (${Array.isArray(data) ? data.length : 0} sampled)`;
  });
}

await check("data/record-count", async () => {
  const rows = await rest.select("records", { user_id: `eq.${owner.id}`, select: "id", limit: 2000 });
  return `${rows.length} canonical records`;
});

await check("data/source-count", async () => {
  const rows = await rest.select("source_documents", { user_id: `eq.${owner.id}`, select: "id", limit: 2000 });
  return `${rows.length} source documents`;
});

await check("rpc/match_records_hybrid_v3", async () => {
  const { data } = await rest.request("rpc/match_records_hybrid_v3", {
    method: "POST",
    body: {
      p_user_id: owner.id,
      p_query_text: "test",
      p_query_embedding: null,
      p_domain_hints: [],
      p_match_count: 3,
      p_min_similarity: 0.2,
    },
  });
  return `ok (${Array.isArray(data) ? data.length : 0} matches)`;
});

await check("rpc/profile_records_v1", async () => {
  const { data } = await rest.request("rpc/profile_records_v1", {
    method: "POST",
    body: { p_user_id: owner.id, p_match_count: 5, p_per_domain: 1 },
  });
  return `ok (${Array.isArray(data) ? data.length : 0} profile records)`;
});

await check("rpc/match_records_hybrid_v4", async () => {
  const { data } = await rest.request("rpc/match_records_hybrid_v4", {
    method: "POST",
    body: {
      p_user_id: owner.id,
      p_query_text: healthQuery,
      p_query_embedding: null,
      p_domain_hints: ["system", "personal_os"],
      p_required_domains: ["system", "personal_os"],
      p_entity_ids: [],
      p_strict_domain: true,
      p_match_count: 3,
      p_min_similarity: 0.18,
    },
  });
  return `ok (${Array.isArray(data) ? data.length : 0} matches)`;
});

await check("rpc/match_source_chunks_hybrid_v4", async () => {
  const { data } = await rest.request("rpc/match_source_chunks_hybrid_v4", {
    method: "POST",
    body: {
      p_user_id: owner.id,
      p_query_text: healthQuery,
      p_query_embedding: null,
      p_domain_hints: ["system", "personal_os"],
      p_required_domains: ["system", "personal_os"],
      p_entity_ids: [],
      p_strict_domain: true,
      p_include_deep_scope: true,
      p_match_count: 3,
      p_min_similarity: 0.18,
    },
  });
  return `ok (${Array.isArray(data) ? data.length : 0} matches)`;
});

await check("rpc/profile_records_v2", async () => {
  const { data } = await rest.request("rpc/profile_records_v2", {
    method: "POST",
    body: {
      p_user_id: owner.id,
      p_match_count: 5,
      p_per_facet: 1,
    },
  });
  return `ok (${Array.isArray(data) ? data.length : 0} profile records)`;
});

await check("rpc/profile_source_chunks_v1", async () => {
  const { data } = await rest.request("rpc/profile_source_chunks_v1", {
    method: "POST",
    body: {
      p_user_id: owner.id,
      p_match_count: 5,
      p_per_facet: 1,
    },
  });
  return `ok (${Array.isArray(data) ? data.length : 0} history chunks)`;
});

await check("edge-function/telegram-health", async () => {
  const response = await fetch(`${url.replace(/\/$/, "")}/functions/v1/telegram`);
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status}: ${text}`);
  return text;
});

console.table(checks);
if (checks.some((c) => !c.ok)) process.exitCode = 1;
