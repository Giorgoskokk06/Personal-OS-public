#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const scriptsDirectory = path.resolve("scripts");
const scripts = fs.readdirSync(scriptsDirectory).filter((name) => name.endsWith(".mjs")).sort();
const failures = [];

for (const script of scripts) {
  const result = spawnSync(process.execPath, ["--check", path.join(scriptsDirectory, script)], {
    encoding: "utf8",
  });
  if (result.status !== 0) failures.push(`${script}\n${result.stderr || result.stdout}`);
}

if (failures.length) {
  console.error(`Syntax check failed:\n${failures.join("\n")}`);
  process.exit(1);
}

console.log(`Syntax check passed (${scripts.length} scripts checked).`);
