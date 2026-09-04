/**
 * Runtime projection of the canonical booking.surface JSON Schema.
 *
 * dsh tools need self-contained JSON Schemas, while the canonical document is
 * organized with local $refs. This helper derives each action branch directly
 * from those canonical bytes and recursively inlines local references. No
 * model-facing action schema is maintained by hand.
 */

import { readFileSync } from 'node:fs'

const schemaUrl = new URL('../../../schemas/booking.surface.schema.json', import.meta.url)
export const canonicalBookingSurfaceSchema = JSON.parse(readFileSync(schemaUrl, 'utf8'))

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function definitionFromRef(ref, schema) {
  const prefix = '#/$defs/'
  if (typeof ref !== 'string' || !ref.startsWith(prefix)) {
    throw new Error(`booking_schema_external_ref_forbidden:${String(ref)}`)
  }
  const name = ref.slice(prefix.length)
  const definition = schema.$defs?.[name]
  if (!definition) throw new Error(`booking_schema_missing_definition:${name}`)
  return definition
}

function inlineLocalRefs(value, schema, stack = []) {
  if (Array.isArray(value)) return value.map((item) => inlineLocalRefs(item, schema, stack))
  if (typeof value !== 'object' || value === null) return value
  if (typeof value.$ref === 'string') {
    if (stack.includes(value.$ref)) throw new Error(`booking_schema_recursive_ref:${value.$ref}`)
    const { $ref, ...siblings } = value
    return {
      ...inlineLocalRefs(definitionFromRef($ref, schema), schema, [...stack, $ref]),
      ...inlineLocalRefs(siblings, schema, stack),
    }
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inlineLocalRefs(item, schema, stack)]))
}

function canonicalActionSchemaForKind(kind, schema, definitionName) {
  const action = schema.$defs?.[definitionName]
  if (!action) throw new Error('booking_schema_action_union_missing')
  if (Array.isArray(action.allOf)) {
    const branch = action.allOf.find((candidate) => candidate?.if?.properties?.kind?.const === kind)
    const input = branch?.then?.properties?.input
    if (!input) throw new Error(`booking_schema_action_kind_missing:${kind}`)
    return clone(inlineLocalRefs({
      type: action.type,
      required: action.required,
      properties: { ...action.properties, kind: { type: 'string', const: kind }, input },
      additionalProperties: action.additionalProperties,
    }, schema))
  }
  if (!Array.isArray(action.oneOf)) throw new Error('booking_schema_action_union_missing')
  const branch = action.oneOf.find((candidate) => candidate?.allOf?.some((part) => part?.properties?.kind?.const === kind))
  const base = schema.$defs?.ActionBase
  const input = branch?.allOf?.find((part) => part?.properties?.input)?.properties?.input
  if (!base || !input) throw new Error(`booking_schema_action_kind_missing:${kind}`)
  return clone(inlineLocalRefs({
    ...base,
    properties: { ...base.properties, kind: { type: 'string', const: kind }, input },
  }, schema))
}

export function canonicalBookingActionSchemaForKind(kind) {
  return canonicalActionSchemaForKind(kind, canonicalBookingSurfaceSchema, 'Action')
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
