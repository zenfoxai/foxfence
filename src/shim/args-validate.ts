/** Minimal JSON Schema validator for tool arguments (§6.4): a mistyped tool
 * call is repaired or rejected, never forwarded as-is.
 *
 * Deliberately small (auditable core > full draft coverage): supports type,
 * enum, const, properties, required, additionalProperties:false, items,
 * minimum/maximum, minLength/maxLength. Unknown keywords are ignored, so an
 * exotic schema degrades to weaker validation, never to a false rejection. */

export function validateAgainstSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = "arguments",
): string[] {
  const errors: string[] = [];

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t as string))) {
      errors.push(`${path}: expected type ${types.join("|")}, got ${typeName(value)}`);
      return errors; // type mismatch makes deeper checks meaningless
    }
  }

  if (schema.enum !== undefined && Array.isArray(schema.enum)) {
    if (!schema.enum.some((e) => deepEqual(e, value))) {
      errors.push(`${path}: value is not one of the allowed enum values`);
    }
  }
  if (schema.const !== undefined && !deepEqual(schema.const, value)) {
    errors.push(`${path}: value does not match const`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${path}: below minimum ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${path}: above maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value) && schema.items !== null && typeof schema.items === "object") {
    value.forEach((item, i) => {
      errors.push(
        ...validateAgainstSchema(item, schema.items as Record<string, unknown>, `${path}[${i}]`),
      );
    });
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties =
      schema.properties !== null && typeof schema.properties === "object"
        ? (schema.properties as Record<string, unknown>)
        : {};

    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in obj)) {
          errors.push(`${path}: missing required property "${key}"`);
        }
      }
    }
    for (const [key, propSchema] of Object.entries(properties)) {
      if (key in obj && propSchema !== null && typeof propSchema === "object") {
        errors.push(
          ...validateAgainstSchema(
            obj[key],
            propSchema as Record<string, unknown>,
            `${path}.${key}`,
          ),
        );
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in properties)) {
          errors.push(`${path}: unexpected property "${key}"`);
        }
      }
    }
  }

  return errors;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    default:
      return true; // unknown type keyword: don't reject
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
