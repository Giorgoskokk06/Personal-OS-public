#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  canonicalKey,
  clamp01,
  geminiBatchEmbeddings,
  getOwner,
  loadEnv,
  normalizeKey,
  parseArgs,
  parseDateOrNull,
  requiredEnv,
  sha256,
  SupabaseRest,
  vectorLiteral,
} from "./lib.mjs";

loadEnv();
const { positional, flags } = parseArgs();
const inputPath = positional[0];
if (!inputPath) {
  console.error("Usage: npm run import:os -- <import.json> [--dry-run] [--no-embed]");
  process.exit(1);
}

const absolute = path.resolve(inputPath);
const payload = JSON.parse(fs.readFileSync(absolute, "utf8"));
if (payload.format_version && payload.format_version !== 1) throw new Error(`Unsupported format_version ${payload.format_version}`);

const noEmbed = Boolean(flags["no-embed"]);
const dryRun = Boolean(flags["dry-run"]);
const rest = new SupabaseRest(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
const owner = await getOwner(rest);
const now = new Date().toISOString();

const source = payload.source ?? {
  source_type: "manual_import",
  title: path.basename(absolute),
  original_filename: path.basename(absolute),
  authority_level: 70,
  sensitivity: "personal_safe",
  content_hash: sha256(fs.readFileSync(absolute)),
  metadata: {},
};

const chunks = Array.isArray(payload.chunks) ? payload.chunks : [];
const records = Array.isArray(payload.records) ? payload.records : [];
const links = Array.isArray(payload.links) ? payload.links : [];
const sensitivity = source.sensitivity || "personal_safe";

if (["work_confidential", "restricted"].includes(sensitivity) && chunks.some((c) => String(c?.content ?? "").trim())) {
  throw new Error(`Refusing to import raw chunks with sensitivity=${sensitivity}. Import only sanitized structured records into the Personal OS.`);
}

console.log(`Owner: ${owner.display_name || owner.telegram_user_id}`);
console.log(`Source: ${source.title || source.original_filename || "manual import"}`);
console.log(`Chunks: ${chunks.length}, records: ${records.length}, links: ${links.length}`);
console.log(`Embeddings: ${noEmbed ? "disabled" : (process.env.GEMINI_API_KEY ? "enabled" : "skipped (no GEMINI_API_KEY)")}`);

console.log(`Source role/scope: ${source.source_role || "canonical"}/${source.retrieval_scope || "standard"}`);

function inferEntityFromRecord(record) {
  if (!record || !Array.isArray(record.domains) || (!record.domains.includes("dating") && !record.domains.includes("relationships"))) return null;
  const prefix = String(record.title || "").split(/\s+[—–-]\s+/, 1)[0].trim();
  const normalized = normalizeKey(prefix);
  const privateOwnerAliases = String(process.env.PERSONAL_OS_OWNER_ALIASES ?? "")
    .split(",")
    .map(normalizeKey)
    .filter(Boolean);
  const generic = new Set(["dating", "relationship", "relationships", "σχεση", "σχεσεις", "σχέση", "σχέσεις", "father", "user", "owner", ...privateOwnerAliases]);
  if (!prefix || prefix.length > 80 || prefix.split(/\s+/).length > 5 || generic.has(normalized)) return null;
  return { name: prefix, entity_type: "person", relation_type: "subject", aliases: [], domains: record.domains };
}

function normalizeEntitySpec(spec, fallbackDomains = []) {
  if (!spec) return null;
  if (typeof spec === "string") return { name: spec, entity_type: "other", relation_type: "related", aliases: [], domains: fallbackDomains };
  const name = String(spec.name || spec.canonical_name || "").trim();
  if (!name) return null;
  return {
    ref: spec.ref ? String(spec.ref) : null,
    name,
    entity_type: ["person", "organization", "project", "place", "other"].includes(spec.entity_type) ? spec.entity_type : "other",
    relation_type: String(spec.relation_type || "related"),
    aliases: Array.isArray(spec.aliases) ? spec.aliases.map(String).filter(Boolean) : [],
    domains: Array.isArray(spec.domains) ? spec.domains.map(String).filter(Boolean) : fallbackDomains,
    metadata: spec.metadata && typeof spec.metadata === "object" ? spec.metadata : {},
  };
}

async function ensureEntity(spec) {
  const entity = normalizeEntitySpec(spec, spec?.domains || []);
  if (!entity) return null;
  const normalizedKey = normalizeKey(entity.name);
  const existing = await rest.select("memory_entities", {
    user_id: `eq.${owner.id}`,
    entity_type: `eq.${entity.entity_type}`,
    normalized_key: `eq.${normalizedKey}`,
    select: "id,canonical_name,aliases,domains,metadata",
    limit: 1,
  });
  if (existing.length) {
    const row = existing[0];
    const aliases = [...new Set([...(row.aliases || []), ...entity.aliases, entity.name])];
    const domains = [...new Set([...(row.domains || []), ...entity.domains])];
    await rest.patch("memory_entities", { id: `eq.${row.id}` }, {
      aliases,
      domains,
      metadata: { ...(row.metadata || {}), ...(entity.metadata || {}) },
      updated_at: new Date().toISOString(),
    });
    return { id: row.id, ...entity };
  }
  const inserted = await rest.insert("memory_entities", {
    user_id: owner.id,
    entity_type: entity.entity_type,
    canonical_name: entity.name,
    normalized_key: normalizedKey,
    aliases: [...new Set([entity.name, ...entity.aliases])],
    domains: entity.domains,
    status: "active",
    metadata: entity.metadata || {},
  }, { select: "id" });
  return inserted?.[0]?.id ? { id: inserted[0].id, ...entity } : null;
}

async function findCurrentRelationshipByEntity(entityId) {
  if (!entityId) return null;
  const linked = await rest.select("record_entities", {
    entity_id: `eq.${entityId}`,
    select: "record_id",
    limit: 100,
  });
  const ids = [...new Set(linked.map((row) => row.record_id).filter(Boolean))];
  if (!ids.length) return null;
  const rows = await rest.select("records", {
    user_id: `eq.${owner.id}`,
    record_type: "eq.relationship",
    id: `in.(${ids.join(",")})`,
    status: "not.in.(deleted,superseded,inactive,closed,completed)",
    knowledge_status: "neq.superseded",
    select: "id,canonical_key,occurred_at,updated_at,status,knowledge_status",
    order: "updated_at.desc",
    limit: 1,
  });
  return rows[0] ?? null;
}

if (dryRun) {
  console.log("Dry run only; no database writes performed.");
  process.exit(0);
}

let sourceDocumentId = null;
let ingestionRunId = null;
const sourceHash = source.content_hash || sha256(JSON.stringify({ source, chunks }));

try {
  const existingDocs = await rest.select("source_documents", {
    user_id: `eq.${owner.id}`,
    content_hash: `eq.${sourceHash}`,
    select: "id,title,content_hash",
    limit: 1,
  });

  if (existingDocs.length) {
    sourceDocumentId = existingDocs[0].id;
    console.log(`Source document already exists: ${sourceDocumentId}`);
  } else {
    const inserted = await rest.insert("source_documents", {
      user_id: owner.id,
      source_type: source.source_type || "manual_import",
      title: source.title || null,
      original_filename: source.original_filename || path.basename(absolute),
      external_ref: source.external_ref || null,
      version: source.version || null,
      authority_level: Math.max(0, Math.min(100, Number(source.authority_level ?? 60))),
      sensitivity,
      source_role: source.source_role || "canonical",
      retrieval_scope: source.retrieval_scope || "standard",
      domains: Array.isArray(source.domains) ? source.domains : [],
      content_hash: sourceHash,
      raw_storage_path: null,
      metadata: source.metadata || {},
      captured_at: parseDateOrNull(source.captured_at),
    }, { select: "id" });
    sourceDocumentId = inserted?.[0]?.id;
    if (!sourceDocumentId) throw new Error("Source document insert returned no id");
    console.log(`Created source document: ${sourceDocumentId}`);
  }

  const run = await rest.insert("ingestion_runs", {
    user_id: owner.id,
    source_document_id: sourceDocumentId,
    mode: "import_script",
    status: "processing",
    started_at: now,
    stats: { input_file: path.basename(absolute) },
  }, { select: "id" });
  ingestionRunId = run?.[0]?.id ?? null;

  const shouldEmbed = !noEmbed && Boolean(process.env.GEMINI_API_KEY);
  let chunkEmbeddings = null;
  if (shouldEmbed && chunks.length) {
    const texts = chunks.map((chunk) => `title: ${chunk.heading || source.title || "none"} | text: ${String(chunk.content ?? "")}`);
    chunkEmbeddings = await geminiBatchEmbeddings(texts);
  }

  const chunkRows = chunks.map((chunk, index) => ({
    source_document_id: sourceDocumentId,
    chunk_index: Number.isInteger(chunk.chunk_index) ? chunk.chunk_index : index,
    heading: chunk.heading || null,
    content: String(chunk.content ?? "").trim(),
    content_hash: chunk.content_hash || sha256(String(chunk.content ?? "")),
    metadata: chunk.metadata || {},
    domains: Array.isArray(chunk.domains) ? chunk.domains : (Array.isArray(source.domains) ? source.domains : []),
    occurred_at: parseDateOrNull(chunk.occurred_at),
    embedding: chunkEmbeddings ? vectorLiteral(chunkEmbeddings[index]) : null,
    embedding_model: chunkEmbeddings ? (process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2") : null,
    embedding_updated_at: chunkEmbeddings ? new Date().toISOString() : null,
  })).filter((row) => row.content);

  let insertedChunks = [];
  if (chunkRows.length) {
    insertedChunks = await rest.insert("source_chunks", chunkRows, {
      onConflict: "source_document_id,chunk_index",
      merge: true,
      representation: true,
      select: "id,chunk_index",
    });
    console.log(`Upserted ${insertedChunks.length} source chunks.`);
  }

  const chunkIdByIndex = new Map((insertedChunks || []).map((row) => [Number(row.chunk_index), row.id]));

  const entityByRef = new Map();
  const entityByName = new Map();
  const topLevelEntities = Array.isArray(payload.entities) ? payload.entities : [];
  for (const raw of topLevelEntities) {
    const entity = await ensureEntity(raw);
    if (!entity) continue;
    if (entity.ref) entityByRef.set(entity.ref, entity.id);
    entityByName.set(normalizeKey(entity.name), entity.id);
    for (const alias of entity.aliases || []) entityByName.set(normalizeKey(alias), entity.id);
  }

  let recordEmbeddings = null;
  if (shouldEmbed && records.length) {
    const texts = records.map((record) => {
      const data = record.data && typeof record.data === "object" ? JSON.stringify(record.data) : "";
      return `title: ${record.title || "none"} | text: ${[record.body, data].filter(Boolean).join("\n")}`;
    });
    recordEmbeddings = await geminiBatchEmbeddings(texts);
  }

  const refs = new Map();
  const importedRecordIds = [];
  const preparedRecords = [];
  const relationshipPreparedIndexByEntity = new Map();

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record?.record_type || !String(record?.title ?? "").trim()) {
      console.warn(`Skipping record ${i + 1}: record_type and title are required.`);
      continue;
    }

    const occurredAt = parseDateOrNull(record.occurred_at);
    const dueAt = parseDateOrNull(record.due_at);
    let key = canonicalKey({ ...record, occurred_at: occurredAt, due_at: dueAt });
    let relationshipEntityId = null;

    if (record.record_type === "relationship") {
      let specs = Array.isArray(record.entities) ? record.entities : [];
      if (!specs.length) {
        const inferred = inferEntityFromRecord(record);
        if (inferred) specs = [inferred];
      }
      const personSpec = specs
        .map((rawSpec) => normalizeEntitySpec(rawSpec, Array.isArray(record.domains) ? record.domains : []))
        .find((spec) => spec?.entity_type === "person");
      if (personSpec) {
        relationshipEntityId = personSpec.ref ? entityByRef.get(personSpec.ref) : null;
        if (!relationshipEntityId) relationshipEntityId = entityByName.get(normalizeKey(personSpec.name));
        if (!relationshipEntityId) {
          const entity = await ensureEntity(personSpec);
          if (entity?.id) {
            relationshipEntityId = entity.id;
            if (entity.ref) entityByRef.set(entity.ref, entity.id);
            entityByName.set(normalizeKey(entity.name), entity.id);
            for (const alias of entity.aliases || []) entityByName.set(normalizeKey(alias), entity.id);
          }
        }
        if (relationshipEntityId) {
          const current = await findCurrentRelationshipByEntity(relationshipEntityId);
          if (current?.canonical_key) key = current.canonical_key;
        }
      }
    }

    const authority = Math.max(0, Math.min(100, Number(record.authority_level ?? source.authority_level ?? 60)));
    const row = {
      user_id: owner.id,
      coach_key: record.coach_key || "default",
      record_type: record.record_type,
      domains: Array.isArray(record.domains) ? record.domains : [],
      title: String(record.title).trim().slice(0, 500),
      body: record.body ? String(record.body).trim().slice(0, 8000) : null,
      status: record.status || "active",
      fact_state: record.fact_state || "unknown",
      knowledge_status: record.knowledge_status || (record.fact_state === "assumption" || record.fact_state === "candidate_design" ? "hypothesis" : "observed"),
      confidence: clamp01(record.confidence, 0.7),
      importance: clamp01(record.importance, 0.5),
      authority_level: authority,
      priority: Number(record.priority) >= 1 && Number(record.priority) <= 5 ? Number(record.priority) : null,
      occurred_at: occurredAt,
      due_at: dueAt,
      valid_from: parseDateOrNull(record.valid_from),
      valid_to: parseDateOrNull(record.valid_to),
      canonical_key: key,
      data: record.data && typeof record.data === "object" ? record.data : {},
      embedding: recordEmbeddings ? vectorLiteral(recordEmbeddings[i]) : null,
      embedding_model: recordEmbeddings ? (process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2") : null,
      embedding_updated_at: recordEmbeddings ? new Date().toISOString() : null,
      last_seen_at: new Date().toISOString(),
    };
    const refsToBind = [record.ref, record.canonical_key, key].filter(Boolean).map(String);
    if (relationshipEntityId && relationshipPreparedIndexByEntity.has(relationshipEntityId)) {
      // Multiple current-status summaries for the same person in one import collapse to
      // the latest input row. Historical detail remains in source chunks / record history.
      const existingIndex = relationshipPreparedIndexByEntity.get(relationshipEntityId);
      const previous = preparedRecords[existingIndex];
      preparedRecords[existingIndex] = {
        input: record,
        row,
        key,
        relationshipEntityId,
        refsToBind: [...new Set([...(previous.refsToBind || []), ...refsToBind])],
      };
    } else {
      if (relationshipEntityId) relationshipPreparedIndexByEntity.set(relationshipEntityId, preparedRecords.length);
      preparedRecords.push({ input: record, row, key, relationshipEntityId, refsToBind });
    }
  }

  const savedMap = new Map();
  for (let i = 0; i < preparedRecords.length; i += 100) {
    const batch = preparedRecords.slice(i, i + 100);
    const savedRows = await rest.insert("records", batch.map((x) => x.row), {
      onConflict: "user_id,coach_key,record_type,canonical_key",
      merge: true,
      representation: true,
      select: "id,record_type,canonical_key",
    });
    for (const saved of savedRows ?? []) {
      savedMap.set(`${saved.record_type}|${saved.canonical_key}`, saved);
      importedRecordIds.push(saved.id);
    }
  }

  const documentSourceRows = [];
  const chunkSourceRows = [];

  for (const prepared of preparedRecords) {
    const record = prepared.input;
    const saved = savedMap.get(`${prepared.row.record_type}|${prepared.key}`);
    if (!saved?.id) throw new Error(`Record upsert returned no id for ${record.title}`);

    for (const ref of prepared.refsToBind || []) refs.set(ref, saved.id);
    refs.set(record.ref || prepared.key, saved.id);
    refs.set(prepared.key, saved.id);

    const chunkIndexes = Array.isArray(record.source_chunk_indexes)
      ? record.source_chunk_indexes
      : (Number.isInteger(record.source_chunk_index) ? [record.source_chunk_index] : []);

    if (chunkIndexes.length) {
      for (const idx of chunkIndexes) {
        const chunkId = chunkIdByIndex.get(Number(idx));
        if (!chunkId) continue;
        chunkSourceRows.push({
          record_id: saved.id,
          source_chunk_id: chunkId,
          source_role: record.source_role || "supports",
          confidence: clamp01(record.source_confidence, 1),
          metadata: {},
        });
      }
    } else if (sourceDocumentId) {
      documentSourceRows.push({
        record_id: saved.id,
        source_document_id: sourceDocumentId,
        source_role: record.source_role || "supports",
        confidence: clamp01(record.source_confidence, 1),
        metadata: {},
      });
    }
  }

  const recordEntityRows = [];
  for (const prepared of preparedRecords) {
    const record = prepared.input;
    const saved = savedMap.get(`${prepared.row.record_type}|${prepared.key}`);
    if (!saved?.id) continue;
    let specs = Array.isArray(record.entities) ? record.entities : [];
    if (!specs.length) {
      const inferred = inferEntityFromRecord(record);
      if (inferred) specs = [inferred];
    }
    for (const rawSpec of specs) {
      const spec = normalizeEntitySpec(rawSpec, prepared.row.domains || []);
      if (!spec) continue;
      let entityId = spec.ref ? entityByRef.get(spec.ref) : null;
      if (!entityId) entityId = entityByName.get(normalizeKey(spec.name));
      if (!entityId) {
        const entity = await ensureEntity(spec);
        if (!entity) continue;
        entityId = entity.id;
        if (entity.ref) entityByRef.set(entity.ref, entity.id);
        entityByName.set(normalizeKey(entity.name), entity.id);
        for (const alias of entity.aliases || []) entityByName.set(normalizeKey(alias), entity.id);
      }
      recordEntityRows.push({ record_id: saved.id, entity_id: entityId, relation_type: spec.relation_type || "related", confidence: 1, metadata: {} });
    }
  }

  const chunkEntityRows = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const chunkIndex = Number.isInteger(chunk.chunk_index) ? chunk.chunk_index : i;
    const chunkId = chunkIdByIndex.get(Number(chunkIndex));
    if (!chunkId || !Array.isArray(chunk.entities)) continue;
    for (const rawSpec of chunk.entities) {
      const spec = normalizeEntitySpec(rawSpec, chunk.domains || source.domains || []);
      if (!spec) continue;
      let entityId = spec.ref ? entityByRef.get(spec.ref) : null;
      if (!entityId) entityId = entityByName.get(normalizeKey(spec.name));
      if (!entityId) {
        const entity = await ensureEntity(spec);
        if (!entity) continue;
        entityId = entity.id;
        if (entity.ref) entityByRef.set(entity.ref, entity.id);
        entityByName.set(normalizeKey(entity.name), entity.id);
      }
      chunkEntityRows.push({ source_chunk_id: chunkId, entity_id: entityId, relation_type: spec.relation_type || "mentioned", confidence: 1, metadata: {} });
    }
  }

  for (let i = 0; i < recordEntityRows.length; i += 200) {
    await rest.insert("record_entities", recordEntityRows.slice(i, i + 200), {
      onConflict: "record_id,entity_id,relation_type", merge: true, representation: false,
    });
  }
  for (let i = 0; i < chunkEntityRows.length; i += 200) {
    await rest.insert("source_chunk_entities", chunkEntityRows.slice(i, i + 200), {
      onConflict: "source_chunk_id,entity_id,relation_type", merge: true, representation: false,
    });
  }

  for (let i = 0; i < documentSourceRows.length; i += 200) {
    await rest.insert("record_sources", documentSourceRows.slice(i, i + 200), {
      onConflict: "record_id,source_document_id",
      merge: true,
      representation: false,
    });
  }
  for (let i = 0; i < chunkSourceRows.length; i += 200) {
    await rest.insert("record_sources", chunkSourceRows.slice(i, i + 200), {
      onConflict: "record_id,source_chunk_id",
      merge: true,
      representation: false,
    });
  }

  const linkRows = [];
  for (const link of links) {
    const fromId = link.from_record_id || refs.get(link.from_ref || link.from_key);
    const toId = link.to_record_id || refs.get(link.to_ref || link.to_key);
    if (!fromId || !toId || !link.relation_type || fromId === toId) {
      console.warn("Skipping invalid record link", link);
      continue;
    }
    linkRows.push({
      user_id: owner.id,
      from_record_id: fromId,
      to_record_id: toId,
      relation_type: link.relation_type,
      metadata: link.metadata || {},
    });
  }
  for (let i = 0; i < linkRows.length; i += 200) {
    await rest.insert("record_links", linkRows.slice(i, i + 200), {
      onConflict: "from_record_id,to_record_id,relation_type",
      merge: true,
      representation: false,
    });
  }

  if (payload.current_state && typeof payload.current_state === "object") {
    const state = payload.current_state;
    await rest.insert("current_state", {
      user_id: owner.id,
      coach_key: state.coach_key || "default",
      season: state.season || null,
      primary_growth_arena: state.primary_growth_arena || null,
      secondary_growth_arena: state.secondary_growth_arena || null,
      main_risk: state.main_risk || null,
      technical_bottleneck: state.technical_bottleneck || null,
      career_bottleneck: state.career_bottleneck || null,
      top_priorities: Array.isArray(state.top_priorities) ? state.top_priorities.slice(0, 3) : [],
      defer_list: Array.isArray(state.defer_list) ? state.defer_list : [],
      fixed_obligations: Array.isArray(state.fixed_obligations) ? state.fixed_obligations : [],
      metadata: state.metadata || {},
    }, { onConflict: "user_id,coach_key", merge: true, representation: false });
  }

  if (ingestionRunId) {
    await rest.patch("ingestion_runs", { id: `eq.${ingestionRunId}` }, {
      status: "completed",
      completed_at: new Date().toISOString(),
      stats: {
        source_document_id: sourceDocumentId,
        chunks: chunkRows.length,
        records: importedRecordIds.length,
        links: links.length,
        record_entity_links: recordEntityRows.length,
        chunk_entity_links: chunkEntityRows.length,
        embeddings: shouldEmbed,
        embedding_model: shouldEmbed ? (process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2") : null,
      },
    });
  }

  console.log(`Import complete. Source=${sourceDocumentId}, records=${importedRecordIds.length}, chunks=${chunkRows.length}`);
} catch (error) {
  if (ingestionRunId) {
    try {
      await rest.patch("ingestion_runs", { id: `eq.${ingestionRunId}` }, {
        status: "failed",
        completed_at: new Date().toISOString(),
        error: String(error?.message || error).slice(0, 1800),
      });
    } catch {}
  }
  throw error;
}
