/**
 * Runtime projection of the canonical booking.surface.v1 JSON Schema.
 *
 * dsh tools need self-contained JSON Schemas, while the canonical document is
 * organized with local $refs. This helper derives each action branch directly
 * from those canonical bytes and recursively inlines local references. No
 * model-facing action schema is maintained by hand.
 */

import { readFileSync } from 'node:fs'

const schemaUrl = new URL('../../../schemas/booking.surface.v1.schema.json', import.meta.url)
export const canonicalBookingSurfaceSchemaV1 = JSON.parse(readFileSync(schemaUrl, 'utf8'))

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function definitionFromRef(ref) {
  const prefix = '#/$defs/'
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) {
    throw new Error(`booking_schema_external_ref_forbidden:${String(ref)}`)
  }
  const name = ref.slice(prefix.length)
  const definition = canonicalBookingSurfaceSchemaV1.$defs?.[name]
  if (!definition) throw new Error(`booking_schema_missing_definition:${name}`)
  return definition
}

function inlineLocalRefs(value, stack = []) {
  if (Array.isArray(value)) return value.map((item) => inlineLocalRefs(item, stack))
  if (typeof value !== 'object' || value === null) return value
  if (typeof value.$ref === 'string') {
    if (stack.includes(value.$ref)) throw new Error(`booking_schema_recursive_ref:${value.$ref}`)
    const { $ref, ...siblings } = value
    return {
      ...inlineLocalRefs(definitionFromRef($ref), [...stack, $ref]),
      ...inlineLocalRefs(siblings, stack),
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inlineLocalRefs(item, stack)]))
}

export function canonicalBookingActionSchemaForKind(kind) {
  const action = canonicalBookingSurfaceSchemaV1.$defs?.BookingReadActionV1
  if (!action || !Array.isArray(action.allOf)) throw new Error('booking_schema_action_union_missing')
  const branch = action.allOf.find((candidate) => candidate?.if?.properties?.kind?.const === kind)
  const input = branch?.then?.properties?.input
  if (!input) throw new Error(`booking_schema_action_kind_missing:${kind}`)
  return clone(inlineLocalRefs({
    type: action.type,
    required: action.required,
    properties: {
      ...action.properties,
      kind: { type: 'string', const: kind },
      input,
    },
    additionalProperties: action.additionalProperties,
  }))
}

const DSH_JSON_SCHEMA_KEYS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'description', 'title', 'default', 'examples',
])

function projectDshSchema(value) {
  if (Array.isArray(value)) return value.map(projectDshSchema)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => DSH_JSON_SCHEMA_KEYS.has(key))
    .map(([key, item]) => {
      if (key === 'properties') {
        return [key, Object.fromEntries(Object.entries(item).map(([name, property]) => [name, projectDshSchema(property)]))]
      }
      return [key, projectDshSchema(item)]
    }))
}

/**
 * dsh-tools intentionally supports a smaller enforced JSON-Schema vocabulary.
 * Keep the canonical shape/type/enum/closure guarantees at the model seam;
 * the full canonical AJV validator remains the runtime authority for numeric,
 * pattern, size and uniqueness constraints before an operation can be issued.
 */
export function dshBookingActionSchemaForKind(kind) {
  return projectDshSchema(canonicalBookingActionSchemaForKind(kind))
}
