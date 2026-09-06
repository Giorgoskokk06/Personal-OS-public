import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function loadEnv(cwd = process.cwd()) {
  for (const filename of [".dev.vars", ".env"]) {
    const file = path.join(cwd, filename);
    if (!fs.existsSync(file)) continue;
    for (const rawLine of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

export function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. Put it in .dev.vars or export it.`);
  return value;
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function normalizeKey(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function canonicalKey(record) {
  if (record.canonical_key) return String(record.canonical_key).slice(0, 120);
  const dateAnchor = String(record.occurred_at || record.due_at || "").slice(0, 10);
  return sha256(`${record.record_type}|${normalizeKey(record.title)}|${dateAnchor}`).slice(0, 48);
}

export function parseArgs(argv = process.argv.slice(2)) {
  const positional = [];
  const flags = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const token = arg.slice(2);
    const eq = token.indexOf("=");
    if (eq === -1) flags[token] = true;
    else flags[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { positional, flags };
}

export function clamp01(value, fallback = 0.5) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export function parseDateOrNull(value) {
  if (!value) return null;
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

export function vectorLiteral(values) {
  return `[${values.join(",")}]`;
}

export class SupabaseRest {
  constructor(url, serviceRoleKey) {
    this.base = url.replace(/\/$/, "") + "/rest/v1";
    this.key = serviceRoleKey;
  }

  async request(resource, { method = "GET", query = {}, body, prefer, headers = {} } = {}) {
    const url = new URL(`${this.base}/${resource}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      method,
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!response.ok) {
      throw new Error(`${method} ${resource} failed ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
    }
    return { data, headers: response.headers };
  }

  async select(resource, query) {
    const { data } = await this.request(resource, { query });
    return data ?? [];
  }

  async insert(resource, body, { onConflict, merge = false, representation = true, select } = {}) {
    const query = {
      ...(onConflict ? { on_conflict: onConflict } : {}),
      ...(select ? { select } : {}),
    };
    const prefer = [
      merge ? "resolution=merge-duplicates" : null,
      representation ? "return=representation" : "return=minimal",
    ].filter(Boolean).join(",");
    const { data } = await this.request(resource, { method: "POST", query, body, prefer });
    return data;
  }

  async patch(resource, query, body, representation = false) {
    const { data } = await this.request(resource, {
      method: "PATCH",
      query,
      body,
      prefer: representation ? "return=representation" : "return=minimal",
    });
    return data;
  }
}

export async function getOwner(rest) {
  const explicitOwnerId =
    String(process.env.PERSONAL_OS_OWNER_USER_ID ?? "").trim();

  if (explicitOwnerId) {
    const rows = await rest.select("users", {
      id: `eq.${explicitOwnerId}`,
      select: "id,telegram_user_id,display_name,timezone",
      limit: 1,
    });

    if (rows.length) return rows[0];
  }

  const telegramId =
    String(process.env.TELEGRAM_ALLOWED_USER_ID ?? "").trim();

  if (telegramId) {
    const rows = await rest.select("users", {
      telegram_user_id: `eq.${telegramId}`,
      select: "id,telegram_user_id,display_name,timezone",
      limit: 1,
    });

    if (rows.length) return rows[0];
  }

  const rows = await rest.select("users", {
    select: "id,telegram_user_id,display_name,timezone",
    limit: 2,
  });

  if (rows.length === 1) {
    return rows[0];
  }

  if (!rows.length) {
    throw new Error(
      "No Personal OS owner exists in the configured Supabase project."
    );
  }

  throw new Error(
    "Owner resolution is ambiguous. Set PERSONAL_OS_OWNER_USER_ID in .dev.vars."
  );
}

export async function geminiBatchEmbeddings(items, { batchSize = 16 } = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !items.length) return null;
  const model = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-2";
  const dimensions = 768;
  const all = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          requests: batch.map((item) => ({
            model: `models/${model}`,
            content: { parts: [{ text: item }] },
            output_dimensionality: dimensions,
          })),
        }),
      });
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status)) break;
      await new Promise((r) => setTimeout(r, 700 * 2 ** attempt));
    }
    if (!response?.ok) throw new Error(`Gemini batch embedding failed ${response?.status}: ${await response?.text()}`);
    const json = await response.json();
    if (!Array.isArray(json.embeddings) || json.embeddings.length !== batch.length) {
      throw new Error(`Unexpected embedding response: ${JSON.stringify(json).slice(0, 600)}`);
    }
    for (const emb of json.embeddings) {
      if (!Array.isArray(emb.values) || emb.values.length !== dimensions) {
        throw new Error("Unexpected embedding dimensions");
      }
      all.push(emb.values);
    }
  }
  return all;
}
