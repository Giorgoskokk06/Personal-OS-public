import { lowerSchema, validateSchema } from "./schema-validation.ts";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

Deno.test("lowerSchema converts provider-style type names", () => {
  const result = lowerSchema({ type: "OBJECT", properties: { count: { type: "INTEGER" } } }) as any;
  assert(result.type === "object", "object type was not normalized");
  assert(result.properties.count.type === "integer", "integer type was not normalized");
  assert(result.additionalProperties === false, "strict object default was not added");
});

Deno.test("validateSchema accepts a valid nested value", () => {
  const schema = {
    type: "OBJECT",
    required: ["status", "items"],
    properties: {
      status: { type: "STRING", enum: ["ok"] },
      items: { type: "ARRAY", items: { type: "INTEGER" } },
    },
  };
  assert(validateSchema({ status: "ok", items: [1, 2] }, schema).length === 0, "valid value was rejected");
});

Deno.test("validateSchema reports missing, wrong-type and enum values", () => {
  const schema = {
    type: "OBJECT",
    required: ["status", "count"],
    properties: {
      status: { type: "STRING", enum: ["ok"] },
      count: { type: "INTEGER" },
    },
  };
  const errors = validateSchema({ status: "bad", count: 1.5 }, schema);
  assert(errors.some((error) => error.includes("outside enum")), "enum violation was not reported");
  assert(errors.some((error) => error.includes("expected integer")), "integer violation was not reported");
  assert(validateSchema({}, schema).length === 2, "missing fields were not reported");
});
