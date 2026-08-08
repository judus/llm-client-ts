/** A JSON scalar value. */
export type JsonPrimitive = boolean | null | number | string;

/** A readonly JSON array. */
export type JsonArray = readonly JsonValue[];

/** A readonly JSON object. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** Any value that can cross a JSON boundary without custom serialization. */
export type JsonValue = JsonArray | JsonObject | JsonPrimitive;

/** A provider-neutral JSON Schema document. */
export type JsonSchema = JsonObject;
