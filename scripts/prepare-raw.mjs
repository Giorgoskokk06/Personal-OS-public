#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { parseArgs, sha256 } from "./lib.mjs";

const { positional, flags } = parseArgs();
const inputPath = positional[0];
if (!inputPath) {
  console.error("Usage: npm run prepare:raw -- <file.md|txt|json|csv> [--type=raw_file] [--authority=60] [--sensitivity=personal_safe] [--out=imports/file.import.json]");
  process.exit(1);
}

const absolute = path.resolve(inputPath);
if (!fs.existsSync(absolute)) throw new Error(`File not found: ${absolute}`);
const filename = path.basename(absolute);
const ext = path.extname(filename).toLowerCase();
const raw = fs.readFileSync(absolute, "utf8");
const maxChars = Number(flags["chunk-chars"] || 6000);
const overlapChars = Number(flags.overlap || 300);

function pushChunk(out, heading, content) {
  const text = content.trim();
  if (!text) return;
  out.push({
    chunk_index: out.length,
    heading: heading || null,
    content: text,
    content_hash: sha256(text),
    metadata: {},
  });
}

function chunkLongText(text, heading, out) {
  let rest = text.trim();
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf("\n\n", maxChars);
    if (cut < maxChars * 0.55) cut = rest.lastIndexOf("\n", maxChars);
    if (cut < maxChars * 0.55) cut = rest.lastIndexOf(" ", maxChars);
    if (cut < maxChars * 0.55) cut = maxChars;
    const piece = rest.slice(0, cut).trim();
    pushChunk(out, heading, piece);
    const overlap = piece.slice(Math.max(0, piece.length - overlapChars));
    rest = `${overlap}\n${rest.slice(cut)}`.trim();
  }
  pushChunk(out, heading, rest);
}

function chunkMarkdown(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  let heading = null;
  let buffer = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (body) chunkLongText(body, heading, out);
    buffer = [];
  };

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) {
      flush();
      heading = match[2].trim();
      buffer.push(line);
    } else {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

function chunkCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.length);
  if (!lines.length) return [];
  const header = lines[0];
  const out = [];
  let block = header;
  let start = 2;
  for (let i = 1; i < lines.length; i++) {
    const candidate = `${block}\n${lines[i]}`;
    if (candidate.length > maxChars && block !== header) {
      pushChunk(out, `CSV rows ${start}-${i}`, block);
      block = `${header}\n${lines[i]}`;
      start = i + 1;
    } else {
      block = candidate;
    }
  }
  pushChunk(out, `CSV rows ${start}-${lines.length}`, block);
  return out;
}

function chunkJson(text) {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value)) {
      const out = [];
      let parts = [];
      let chars = 0;
      let start = 0;
      const flush = (end) => {
        if (!parts.length) return;
        pushChunk(out, `JSON items ${start + 1}-${end}`, `[\n${parts.join(",\n")}\n]`);
        parts = [];
        chars = 0;
        start = end;
      };
      value.forEach((item, index) => {
        const formatted = JSON.stringify(item, null, 2);
        if (parts.length && chars + formatted.length > maxChars) flush(index);
        if (formatted.length > maxChars) {
          chunkLongText(formatted, `JSON item ${index + 1}`, out);
          start = index + 1;
        } else {
          parts.push(formatted);
          chars += formatted.length;
        }
      });
      flush(value.length);
      return out;
    }
    return chunkMarkdown(JSON.stringify(value, null, 2));
  } catch {
    return chunkMarkdown(text);
  }
}

let chunks;
if (ext === ".csv") chunks = chunkCsv(raw);
else if (ext === ".json") chunks = chunkJson(raw);
else chunks = chunkMarkdown(raw);

const sourceType = String(flags.type || (ext === ".md" ? "raw_file" : "raw_file"));
const authority = Math.max(0, Math.min(100, Number(flags.authority || (sourceType === "canonical" ? 85 : 60))));
const sensitivity = String(flags.sensitivity || "personal_safe");
const allowedSensitivity = new Set(["personal_safe", "personal_sensitive", "work_safe", "work_confidential", "restricted"]);
if (!allowedSensitivity.has(sensitivity)) throw new Error(`Invalid sensitivity: ${sensitivity}`);

const payload = {
  format_version: 1,
  source: {
    source_type: sourceType,
    title: String(flags.title || filename.replace(ext, "")),
    original_filename: filename,
    external_ref: null,
    version: flags.version ? String(flags.version) : null,
    authority_level: authority,
    sensitivity,
    content_hash: sha256(raw),
    captured_at: null,
    metadata: {
      prepared_by: "prepare-raw.mjs",
      original_bytes: Buffer.byteLength(raw, "utf8"),
      original_extension: ext || null,
    },
  },
  chunks,
  records: [],
  links: [],
  current_state: null,
};

const defaultOut = path.join("imports", `${filename.replace(/[^A-Za-z0-9._-]/g, "_")}.import.json`);
const outPath = path.resolve(String(flags.out || defaultOut));
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
console.log(`Prepared ${chunks.length} chunks -> ${outPath}`);
console.log(`Source hash: ${payload.source.content_hash}`);
if (["work_confidential", "restricted"].includes(sensitivity)) {
  console.warn("WARNING: This payload contains raw content marked confidential/restricted. import-os.mjs will refuse to import raw chunks into the Personal OS.");
}
