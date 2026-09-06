#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const repoRoot = process.cwd();
const requiredFiles = ["README.md", ".gitignore", ".dev.vars.example", "SECURITY.md"];
const blockedFilePatterns = [
  /^\.env(\..+)?$/i,
  /^\.dev\.vars$/i,
  /^imports\/(historical|updates|private)\//i,
  /^exports\//i,
];
const privateMarkers = String(process.env.PERSONAL_OS_PRIVATE_MARKERS ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const secretPatterns = [
  { name: "github_token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "aws_access_key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "slack_token", regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g },
  { name: "google_api_key", regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { name: "telegram_token", regex: /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g },
  { name: "jwt_like", regex: /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "bearer_token", regex: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
  { name: "private_key", regex: /-----BEGIN (?:RSA|EC|OPENSSH|DSA|PRIVATE) KEY-----/g },
];

function listRepositoryFiles() {
  try {
    const out = execSync("git ls-files -z", { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    return String(out).split("\u0000").filter(Boolean);
  } catch {
    const ignored = new Set([".git", "node_modules", ".wrangler"]);
    const files = [];
    function walk(directory, prefix = "") {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && ignored.has(entry.name)) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(absolute, relative);
        else if (entry.isFile()) files.push(relative);
      }
    }
    walk(repoRoot);
    return files.sort();
  }
}

function looksBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

const files = listRepositoryFiles();
const failures = [];

for (const file of requiredFiles) {
  if (!files.includes(file)) failures.push(`missing required file: ${file}`);
}
for (const file of files) {
  if (blockedFilePatterns.some((pattern) => pattern.test(file))) failures.push(`blocked repository path: ${file}`);
  const absolute = path.join(repoRoot, file);
  if (!fs.existsSync(absolute)) continue;
  const raw = fs.readFileSync(absolute);
  if (looksBinary(raw)) continue;
  const text = raw.toString("utf8");
  for (const marker of privateMarkers) {
    if (text.toLocaleLowerCase().includes(marker.toLocaleLowerCase())) failures.push(`configured private marker in ${file}`);
  }
  for (const rule of secretPatterns) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(text)) failures.push(`possible ${rule.name} in ${file}`);
  }
}

if (failures.length) {
  console.error("Public audit failed:");
  for (const failure of [...new Set(failures)]) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Public audit passed (${files.length} repository files checked).`);
