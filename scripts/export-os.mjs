#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { getOwner, loadEnv, parseArgs, requiredEnv, SupabaseRest } from "./lib.mjs";

loadEnv();
const { flags } = parseArgs();
const rest = new SupabaseRest(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"));
const owner = await getOwner(rest);
const withChunks = Boolean(flags["with-chunks"]);

async function paginate(resource, query = {}, pageSize = 1000) {
  const all = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data } = await rest.request(resource, {
      query: { ...query, limit: pageSize, offset },
    });
    const rows = Array.isArray(data) ? data : [];
    all.push(...rows);
    if (rows.length < pageSize) break;
  }
  return all;
}

const [records, state, sourceDocuments] = await Promise.all([
  paginate("records", {
    user_id: `eq.${owner.id}`,
    select: "id,coach_key,record_type,domains,title,body,status,fact_state,knowledge_status,confidence,importance,authority_level,priority,occurred_at,due_at,valid_from,valid_to,canonical_key,data,last_seen_at,created_at,updated_at",
    order: "updated_at.desc",
  }),
  rest.select("current_state", { user_id: `eq.${owner.id}`, select: "*" }),
  paginate("source_documents", {
    user_id: `eq.${owner.id}`,
    select: "id,source_type,title,original_filename,external_ref,version,authority_level,sensitivity,content_hash,metadata,captured_at,created_at,updated_at",
    order: "created_at.asc",
  }),
]);

let sourceChunks = [];
if (withChunks && sourceDocuments.length) {
  const ids = sourceDocuments.map((d) => d.id).join(",");
  sourceChunks = await paginate("source_chunks", {
    source_document_id: `in.(${ids})`,
    select: "id,source_document_id,chunk_index,heading,content,content_hash,metadata,embedding_model,created_at",
    order: "source_document_id.asc,chunk_index.asc",
  });
}

const output = {
  format_version: 1,
  exported_at: new Date().toISOString(),
  owner: {
    telegram_user_id: owner.telegram_user_id,
    display_name: owner.display_name,
    timezone: owner.timezone,
  },
  current_state: state?.[0] ?? null,
  records,
  source_documents: sourceDocuments,
  ...(withChunks ? { source_chunks: sourceChunks } : {}),
};

const dir = path.resolve("exports");
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = path.join(dir, `personal-os-backup-${stamp}.json`);
fs.writeFileSync(out, JSON.stringify(output, null, 2));
console.log(`Exported ${records.length} records, ${sourceDocuments.length} source documents${withChunks ? `, ${sourceChunks.length} chunks` : ""}.`);
console.log(out);
