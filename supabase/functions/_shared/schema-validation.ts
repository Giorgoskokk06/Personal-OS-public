export function lowerSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lowerSchema);
  if (!value || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "type" && typeof item === "string") {
      const mapped: Record<string, string> = {
        OBJECT: "object",
        ARRAY: "array",
        STRING: "string",
        NUMBER: "number",
        INTEGER: "integer",
        BOOLEAN: "boolean",
      };
      out[key] = mapped[item] ?? item.toLowerCase();
    } else {
      out[key] = lowerSchema(item);
    }
  }

  if (out.type === "object" && out.additionalProperties === undefined) {
    out.additionalProperties = false;
  }
  return out;
}

function typeName(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

export function validateSchema(value: unknown, schema: any, path = "$"): string[] {
  const errors: string[] = [];
  if (!schema || typeof schema !== "object") return errors;

  const expected = String(schema.type ?? "").toLowerCase();
  if (expected === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [`${path}: expected object, got ${typeName(value)}`];
    }
    const objectValue = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in objectValue)) errors.push(`${path}.${key}: missing required field`);
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (key in objectValue) {
        errors.push(...validateSchema(objectValue[key], childSchema, `${path}.${key}`));
      }
    }
  } else if (expected === "array") {
    if (!Array.isArray(value)) return [`${path}: expected array, got ${typeName(value)}`];
    if (schema.items) {
      value.forEach((item, index) => {
        errors.push(...validateSchema(item, schema.items, `${path}[${index}]`));
      });
    }
  } else if (expected === "string" && typeof value !== "string") {
    errors.push(`${path}: expected string, got ${typeName(value)}`);
  } else if (expected === "boolean" && typeof value !== "boolean") {
    errors.push(`${path}: expected boolean, got ${typeName(value)}`);
  } else if (expected === "number" && typeof value !== "number") {
    errors.push(`${path}: expected number, got ${typeName(value)}`);
  } else if (expected === "integer" && !Number.isInteger(value)) {
    errors.push(`${path}: expected integer, got ${typeName(value)}`);
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path}: value is outside enum`);
  }
  return errors;
}
