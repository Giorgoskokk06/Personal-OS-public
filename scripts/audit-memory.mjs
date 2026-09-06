#!/usr/bin/env node
import { getOwner, loadEnv, requiredEnv, SupabaseRest } from "./lib.mjs";

loadEnv();
const rest = new SupabaseRest(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
const owner = await getOwner(rest);

const [entities, recordLinks, chunkLinks, docs, chunks, records, state] = await Promise.all([
  rest.select("memory_entities", { user_id: `eq.${owner.id}`, select: "id,entity_type,canonical_name,aliases,domains,status,metadata", limit: 2000 }),
  rest.select("record_entities", { select: "record_id,entity_id,relation_type", limit: 10000 }),
  rest.select("source_chunk_entities", { select: "source_chunk_id,entity_id,relation_type", limit: 20000 }),
  rest.select("source_documents", { user_id: `eq.${owner.id}`, select: "id,title,source_type,source_role,retrieval_scope,sensitivity,domains,authority_level", limit: 2000 }),
  rest.select("source_chunks", { select: "id,source_document_id,domains,occurred_at,embedding", limit: 10000 }),
  rest.select("records", { user_id: `eq.${owner.id}`, select: "id,record_type,domains,title,status,knowledge_status,embedding", limit: 5000 }),
  rest.select("current_state", { user_id: `eq.${owner.id}`, coach_key: "eq.default", select: "*", limit: 1 }),
]);

const docIds = new Set(docs.map((d) => d.id));
const ownerChunks = chunks.filter((c) => docIds.has(c.source_document_id));
const docById = new Map(docs.map((d) => [d.id, d]));
const sourceGroups = new Map();
for (const doc of docs) {
  const key = `${doc.source_role || "legacy"}/${doc.retrieval_scope || "legacy"}/${doc.sensitivity}`;
  const item = sourceGroups.get(key) || { documents: 0, chunks: 0 };
  item.documents++;
  sourceGroups.set(key, item);
}
for (const chunk of ownerChunks) {
  const doc = docById.get(chunk.source_document_id);
  const key = `${doc?.source_role || "legacy"}/${doc?.retrieval_scope || "legacy"}/${doc?.sensitivity || "unknown"}`;
  const item = sourceGroups.get(key) || { documents: 0, chunks: 0 };
  item.chunks++;
  sourceGroups.set(key, item);
}

console.log(`Owner: ${owner.display_name || owner.telegram_user_id}`);
console.log(`Canonical records: ${records.length}`);
console.log(`Source documents/chunks: ${docs.length}/${ownerChunks.length}`);
console.log(`Memory entities: ${entities.length}`);
console.log(`Record-entity links: ${recordLinks.length}`);
console.log(`Chunk-entity links: ${chunkLinks.length}`);
console.log("\nSources by role/scope/sensitivity:");
console.table([...sourceGroups.entries()].map(([key, v]) => ({ class: key, ...v })));

console.log("\nEntities:");
console.table(entities.map((e) => ({
  type: e.entity_type,
  name: e.canonical_name,
  aliases: (e.aliases || []).join(", "),
  domains: (e.domains || []).join(","),
  record_links: recordLinks.filter((l) => l.entity_id === e.id).length,
  chunk_links: chunkLinks.filter((l) => l.entity_id === e.id).length,
  current_relationship: e.metadata?.current_relationship_record_id || "",
})));

const relationshipRecords = records.filter((r) => r.record_type === "relationship");
const linkedRecordIds = new Set(recordLinks.map((l) => l.record_id));
const unlinkedRelationships = relationshipRecords.filter((r) => !linkedRecordIds.has(r.id));
console.log(`\nRelationship records: ${relationshipRecords.length}; unlinked: ${unlinkedRelationships.length}`);
if (unlinkedRelationships.length) console.table(unlinkedRelationships.map((r) => ({ id: r.id, title: r.title, status: r.status })));

const historicalDocs = docs.filter((d) => d.source_role === "user_evidence" && d.retrieval_scope === "deep");
const historicalDocIds = new Set(historicalDocs.map((d) => d.id));
const historicalChunks = ownerChunks.filter((c) => historicalDocIds.has(c.source_document_id));
console.log(`Historical deep user-evidence: ${historicalDocs.length} documents / ${historicalChunks.length} chunks`);
console.log(`Historical embedded chunks: ${historicalChunks.filter((c) => c.embedding).length} (expected 0 for private deep history)`);

const current = state[0] || null;
if (current) {
  const stateTerm = String(process.env.PERSONAL_OS_CURRENT_STATE_TERM ?? "").trim();
  if (stateTerm) {
    const stateText = JSON.stringify(current).toLocaleLowerCase("el-GR");
    console.log(`Current-state contains configured term: ${stateText.includes(stateTerm.toLocaleLowerCase("el-GR"))}`);
  }
  console.log(`Current-state as_of: ${current.metadata?.as_of || current.metadata?.last_update_at || "unknown"}`);
}
