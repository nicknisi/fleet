// Boundary types + guards for untrusted JSON input. Assert `JSON.parse` output
// to JsonValue once at the I/O boundary (with a SAFETY comment), then narrow
// with these guards instead of ad-hoc `typeof` checks.
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isString(value: JsonValue | undefined): value is string {
  return typeof value === 'string';
}

export function isNumber(value: JsonValue | undefined): value is number {
  return typeof value === 'number';
}
