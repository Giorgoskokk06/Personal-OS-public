#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { getOwner, loadEnv, normalizeKey, requiredEnv, SupabaseRest } from "./lib.mjs";

loadEnv();
const rest = new SupabaseRest(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
const owner = await getOwner(rest);

const entityConfigPath = path.resolve(
  process.env.PERSONAL_OS_ENTITY_CONFIG || "imports/private/entities.json",
);

function loadKnownEntities() {
  if (!fs.existsSync(entityConfigPath)) {
    console.warn(`No private entity seed file found at ${entityConfigPath}; continuing with inferred entities only.`);
    return [];
  }

  const parsed = JSON.parse(fs.readFileSync(entityConfigPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Entity seed file must contain a JSON array.");
  return parsed.map((item, index) => {
    const name = String(item?.name ?? "").trim();
    if (!name) throw new Error(`Entity seed ${index + 1} is missing name.`);
    return {
      name,
      aliases: Array.isArray(item.aliases) ? item.aliases.map(String).filter(Boolean) : [],
      domains: Array.isArray(item.domains) ? item.domains.map(String).filter(Boolean) : [],
    };
  });
}

const KNOWN = loadKnownEntities();

const GENERIC = new Set([
  "dating", "dating development goal", "dating analysis", "relationship", "relationships",
  "σχεση", "σχεσεις", "user", "owner",
]);

function inferPrefix(record) {
  const domains = record.domains || [];
  if (!domains.includes("relationships") && !domains.includes("dating")) return null;
  const title = String(record.title || "").trim();
  const prefix = title.split(/\s+[—–-]\s+/, 1)[0]?.trim();
  const key = normalizeKey(prefix);
  if (!prefix || prefix.length > 80 || prefix.split(/\s+/).length > 5) return null;
  if (GENERIC.has(key) || key.startsWith("dating ")) return null;
  return prefix;
}

async function ensureEntity(name, aliases = [], domains = []) {
  const normalizedKey = normalizeKey(name);
  const found = await rest.select("memory_entities", {
    user_id: `eq.${owner.id}`,
    entity_type: "eq.person",
    normalized_key: `eq.${normalizedKey}`,
    select: "id,canonical_name,aliases,domains,metadata",
    limit: 1,
  });
  if (found.length) {
    const old = found[0];
    await rest.patch("memory_entities", { id: `eq.${old.id}` }, {
      aliases: [...new Set([...(old.aliases || []), name, ...aliases])],
      domains: [...new Set([...(old.domains || []), ...domains])],
      updated_at: new Date().toISOString(),
    });
    return old.id;
  }
  const inserted = await rest.insert("memory_entities", {
    user_id: owner.id,
    entity_type: "person",
    canonical_name: name,
    normalized_key: normalizedKey,
    aliases: [...new Set([name, ...aliases])],
    domains: [...new Set(domains)],
    status: "active",
    metadata: {},
  }, { select: "id" });
  return inserted?.[0]?.id;
}

const records = await rest.select("records", {
  user_id: `eq.${owner.id}`,
  select: "id,record_type,domains,title,status,knowledge_status,occurred_at,valid_to,data,updated_at",
  limit: 2000,
});

const entityIdByKey = new Map();
for (const item of KNOWN) {
  const id = await ensureEntity(item.name, item.aliases, item.domains);
  if (id) {
    entityIdByKey.set(normalizeKey(item.name), id);
    for (const alias of item.aliases) entityIdByKey.set(normalizeKey(alias), id);
  }
}

const recordLinks = [];
for (const record of records) {
  const prefix = inferPrefix(record);
  if (!prefix) continue;
  const key = normalizeKey(prefix);
  let entityId = entityIdByKey.get(key);
  if (!entityId) {
    entityId = await ensureEntity(prefix, [], record.domains || []);
    if (!entityId) continue;
    entityIdByKey.set(key, entityId);
  }
  recordLinks.push({
    record_id: record.id,
    entity_id: entityId,
    relation_type: record.record_type === "relationship" ? "subject" : "related",
    confidence: 1,
    metadata: { backfill: "v1.1-hardened" },
  });
}

for (let i = 0; i < recordLinks.length; i += 200) {
  await rest.insert("record_entities", recordLinks.slice(i, i + 200), {
    onConflict: "record_id,entity_id,relation_type", merge: true, representation: false,
  });
}

const entities = await rest.select("memory_entities", {
  user_id: `eq.${owner.id}`,
  select: "id,canonical_name,aliases,domains,metadata",
  limit: 1000,
});

function textContainsAlias(text, aliases) {
  const hay = ` ${normalizeKey(text)} `;
  return aliases.some((alias) => {
    const needle = normalizeKey(alias);
    return needle.length >= 2 && hay.includes(` ${needle} `);
  });
}

const ownerDocs = await rest.select("source_documents", {
  user_id: `eq.${owner.id}`,
  select: "id",
  limit: 5000,
});
const ownerDocIds = new Set(ownerDocs.map((doc) => doc.id));
const chunks = (await rest.select("source_chunks", {
  select: "id,source_document_id,heading,content,domains",
  limit: 10000,
})).filter((chunk) => ownerDocIds.has(chunk.source_document_id));
const chunkLinks = [];
for (const chunk of chunks) {
  const text = `${chunk.heading || ""}\n${chunk.content || ""}`;
  for (const entity of entities) {
    const aliases = [entity.canonical_name, ...(entity.aliases || [])];
    if (!textContainsAlias(text, aliases)) continue;
    chunkLinks.push({
      source_chunk_id: chunk.id,
      entity_id: entity.id,
      relation_type: "mentioned",
      confidence: 1,
      metadata: { backfill: "v1.1-hardened" },
    });
  }
}
for (let i = 0; i < chunkLinks.length; i += 200) {
  await rest.insert("source_chunk_entities", chunkLinks.slice(i, i + 200), {
    onConflict: "source_chunk_id,entity_id,relation_type", merge: true, representation: false,
  });
}

const allLinks = await rest.select("record_entities", { select: "record_id,entity_id,relation_type", limit: 5000 });
let supersededRelationshipSummaries = 0;
for (const entity of entities) {
  const ids = allLinks.filter((l) => l.entity_id === entity.id).map((l) => l.record_id);
  const relationshipRows = records
    .filter((r) => ids.includes(r.id) && r.record_type === "relationship" && !["inactive", "deleted", "superseded", "closed", "completed"].includes(r.status) && r.knowledge_status !== "superseded")
    .sort((a, b) => {
      const aPrimary = Date.parse(a.occurred_at || "") || 0;
      const bPrimary = Date.parse(b.occurred_at || "") || 0;
      if (aPrimary !== bPrimary) return bPrimary - aPrimary;
      return (Date.parse(b.updated_at || "") || 0) - (Date.parse(a.updated_at || "") || 0);
    });
  const candidate = relationshipRows[0];
  if (!candidate) continue;

  // A relationship record is the current status summary for one person. If old imports
  // left multiple parallel active summaries, keep the newest current node and supersede
  // the older summaries. The record_history trigger preserves the old snapshots.
  for (const older of relationshipRows.slice(1)) {
    await rest.patch("records", { id: `eq.${older.id}`, user_id: `eq.${owner.id}` }, {
      status: "superseded",
      knowledge_status: "superseded",
      valid_to: candidate.occurred_at || new Date().toISOString(),
      data: {
        ...(older.data || {}),
        superseded_by_record_id: candidate.id,
        superseded_reason: "entity_current_relationship_reconciliation",
      },
      last_seen_at: new Date().toISOString(),
    });
    supersededRelationshipSummaries += 1;
  }

  await rest.patch("memory_entities", { id: `eq.${entity.id}` }, {
    metadata: { ...(entity.metadata || {}), current_relationship_record_id: candidate.id, graph_backfilled_at: new Date().toISOString() },
    updated_at: new Date().toISOString(),
  });
}

console.log(`Owner: ${owner.display_name || owner.telegram_user_id}`);
console.log(`Entities: ${entities.length}`);
console.log(`Record-entity links upserted: ${recordLinks.length}`);
console.log(`Chunk-entity links upserted: ${chunkLinks.length}`);
console.log(`Older parallel relationship summaries superseded: ${supersededRelationshipSummaries}`);
console.log("Entity graph backfill complete. No records were deleted; older current-status summaries are preserved in record history/source evidence.");
