import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalKey, normalizeKey } from "../../scripts/lib.mjs";

// An offline code walkthrough, not a mock model response.
// Do not call loadEnv, import operational scripts, or add provider calls here.
const sample = JSON.parse(
  readFileSync(new URL("../../imports/example_import.json", import.meta.url), "utf8"),
);
assert.equal(sample.format_version, 1);
assert.ok(Array.isArray(sample.records) && sample.records.length > 0);

const first = { record_type: "goal", title: "  Practice SQL Joins  " };
const equivalent = { record_type: "goal", title: "practice   sql joins" };
const dayOne = { record_type: "event", title: "Synthetic review", occurred_at: "2030-01-01" };
const dayTwo = { ...dayOne, occurred_at: "2030-01-02" };

assert.equal(canonicalKey(first), canonicalKey(equivalent));
assert.notEqual(canonicalKey(dayOne), canonicalKey(dayTwo));

console.log("PERSONAL OS / OFFLINE CODE DEMO");
console.log("Synthetic data. No provider calls, database access or writes.");
console.log("");
console.log("Normalized title:", normalizeKey(first.title));
console.log("Equivalent title keys match: PASS");
console.log("Different event dates produce different keys: PASS");
console.log("Sample import records:", sample.records.length);
for (const record of sample.records) {
  console.log(" -", record.record_type + ":", record.title);
}
console.log("");
console.log("This checks helpers and the example shape, not live memory persistence.");
