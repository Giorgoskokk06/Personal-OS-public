import test from "node:test";
import assert from "node:assert/strict";
import { canonicalKey, clamp01, normalizeKey, parseArgs, parseDateOrNull, vectorLiteral } from "../scripts/lib.mjs";

test("normalizeKey normalizes case, accents and whitespace", () => {
  assert.equal(normalizeKey("  Πλάνο—Μάθησης  "), "πλανο μαθησης");
});

test("canonicalKey is stable for equivalent titles", () => {
  const first = canonicalKey({ record_type: "goal", title: "Πλάνο Μάθησης" });
  const second = canonicalKey({ record_type: "goal", title: "πλανο   μαθησης" });
  assert.equal(first, second);
  assert.equal(first.length, 48);
});

test("canonicalKey changes with its date anchor", () => {
  const first = canonicalKey({ record_type: "event", title: "Review", occurred_at: "2026-09-01" });
  const second = canonicalKey({ record_type: "event", title: "Review", occurred_at: "2026-09-02" });
  assert.notEqual(first, second);
});

test("parseArgs separates positional arguments and flags", () => {
  assert.deepEqual(parseArgs(["input.json", "--dry-run", "--type=canonical"]), {
    positional: ["input.json"],
    flags: { "dry-run": true, type: "canonical" },
  });
});

test("clamp01 bounds numeric values and uses fallback", () => {
  assert.equal(clamp01(2), 1);
  assert.equal(clamp01(-1), 0);
  assert.equal(clamp01("invalid", 0.7), 0.7);
});

test("parseDateOrNull handles valid and invalid dates", () => {
  assert.equal(parseDateOrNull("2026-09-06"), "2026-09-06T00:00:00.000Z");
  assert.equal(parseDateOrNull("not-a-date"), null);
});

test("vectorLiteral creates pgvector text", () => {
  assert.equal(vectorLiteral([0.1, -0.2, 1]), "[0.1,-0.2,1]");
});
