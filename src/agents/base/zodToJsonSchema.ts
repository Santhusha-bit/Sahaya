import { z } from "zod";

/**
 * Minimal zod -> JSON Schema converter covering exactly the constructs the
 * agent tools use (objects, strings, numbers, booleans, enums, arrays,
 * optional / default / nullable, and descriptions). Produces the
 * `input_schema` shape the Claude Messages API expects.
 */
export function zodToJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return convert(schema);
}

function convert(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = (schema as any)._def;
  const typeName = def?.typeName as string | undefined;

  switch (typeName) {
    case "ZodObject": {
      const shape = def.shape();
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        const v = value as z.ZodTypeAny;
        properties[key] = convert(v);
        if (!isOptional(v)) required.push(key);
      }
      const out: Record<string, unknown> = { type: "object", properties };
      if (required.length) out.required = required;
      out.additionalProperties = false;
      return withDescription(schema, out);
    }
    case "ZodString":
      return withDescription(schema, { type: "string" });
    case "ZodNumber":
      return withDescription(schema, { type: "number" });
    case "ZodBoolean":
      return withDescription(schema, { type: "boolean" });
    case "ZodEnum":
      return withDescription(schema, { type: "string", enum: def.values });
    case "ZodNativeEnum":
      return withDescription(schema, { type: "string", enum: Object.values(def.values) });
    case "ZodArray":
      return withDescription(schema, { type: "array", items: convert(def.type) });
    case "ZodOptional":
    case "ZodNullable":
      return convert(def.innerType);
    case "ZodDefault":
      return convert(def.innerType);
    case "ZodLiteral":
      return withDescription(schema, { const: def.value });
    default:
      return { type: "string" };
  }
}

function isOptional(schema: z.ZodTypeAny): boolean {
  const typeName = (schema as any)._def?.typeName;
  return typeName === "ZodOptional" || typeName === "ZodDefault" || typeName === "ZodNullable";
}

function withDescription(schema: z.ZodTypeAny, out: Record<string, unknown>): Record<string, unknown> {
  const description = (schema as any)._def?.description;
  if (description) out.description = description;
  return out;
}
