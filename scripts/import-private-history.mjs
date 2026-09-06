#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "./lib.mjs";

const { flags } = parseArgs();
const dir = path.resolve("imports/private");
if (!fs.existsSync(dir)) throw new Error("imports/private not found. Apply the hardened upgrade package first.");
const files = fs.readdirSync(dir).filter((name) => name.endsWith(".import.json")).sort();
if (!files.length) throw new Error("No private history import payloads found.");

console.log(`Private history files: ${files.length}`);
console.log("Policy: user-authored evidence only; assistant output excluded; embeddings disabled.");
for (const file of files) {
  const args = ["scripts/import-os.mjs", path.join(dir, file), "--no-embed"];
  if (flags["dry-run"]) args.push("--dry-run");
  console.log(`\n== ${file} ==`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit", env: process.env });
  if (result.status !== 0) process.exit(result.status || 1);
}
