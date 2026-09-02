/** Closed, non-sensitive error vocabulary for planner/runtime boundaries. */
export const BOOKING_TYPED_ERROR_CODES = [
  'PAYLOAD_TOO_LARGE',
  'TASK_NOT_FOUND',
  'TASK_TERMINAL',
  'RECEIPT_REQUIRED',
  'RECEIPT_CONFLICT',
  'UNSUPPORTED_ACTION',
  'PLANNER_SURFACE_ACTION_UNSUPPORTED',
  'PLANNER_NO_DECISION',
  'PLANNER_TYPED_DECISION_REQUIRED',
  'PLANNER_FAILED',
  'INVALID_ACTION',
  'INVALID_EVENT',
  'CONTEXT_MISMATCH',
  'WORKSPACE_MISMATCH',
  'ACTION_CONFLICT',
  'STALE_REVISION',
  'OPERATION_LIMIT_REACHED',
  'AVAILABILITY_TERMINAL_POLICY_OWNED',
  'TRUSTED_INGRESS_BINDING_REQUIRED',
  'INVALID_INGRESS_BINDING',
  'BOOKING_SURFACE_SCHEMA_MISMATCH',
  'UNAUTHORIZED',
  'NOT_FOUND',
] as const

export type BookingTypedErrorCode = typeof BOOKING_TYPED_ERROR_CODES[number]

const ALIASES: Record<string, BookingTypedErrorCode> = {
  payload_too_large: 'PAYLOAD_TOO_LARGE',
  task_not_found: 'TASK_NOT_FOUND',
  task_terminal: 'TASK_TERMINAL',
  receipt_required: 'RECEIPT_REQUIRED',
  receipt_conflict: 'RECEIPT_CONFLICT',
  unsupported_action: 'UNSUPPORTED_ACTION',
  planner_surface_action_unsupported: 'PLANNER_SURFACE_ACTION_UNSUPPORTED',
  planner_no_decision: 'PLANNER_NO_DECISION',
  planner_typed_decision_required: 'PLANNER_TYPED_DECISION_REQUIRED',
  planner_failed: 'PLANNER_FAILED',
  invalid_action: 'INVALID_ACTION',
  invalid_event: 'INVALID_EVENT',
  context_mismatch: 'CONTEXT_MISMATCH',
  workspace_mismatch: 'WORKSPACE_MISMATCH',
  action_conflict: 'ACTION_CONFLICT',
  stale_revision: 'STALE_REVISION',
  operation_limit_reached: 'OPERATION_LIMIT_REACHED',
  availability_terminal_policy_owned: 'AVAILABILITY_TERMINAL_POLICY_OWNED',
  trusted_ingress_binding_required: 'TRUSTED_INGRESS_BINDING_REQUIRED',
  invalid_ingress_binding: 'INVALID_INGRESS_BINDING',
  booking_surface_schema_mismatch: 'BOOKING_SURFACE_SCHEMA_MISMATCH',
  unauthorized: 'UNAUTHORIZED',
  not_found: 'NOT_FOUND',
}

const SAFE_MESSAGES: Record<BookingTypedErrorCode, string> = {
  PAYLOAD_TOO_LARGE: 'Request payload exceeds the configured limit.',
  TASK_NOT_FOUND: 'The requested task was not found.',
  TASK_TERMINAL: 'The task is already terminal.',
  RECEIPT_REQUIRED: 'A matching receipt is required before another action.',
  RECEIPT_CONFLICT: 'The receipt conflicts with the durable task record.',
  UNSUPPORTED_ACTION: 'The requested action is outside the trusted action policy.',
  PLANNER_SURFACE_ACTION_UNSUPPORTED: 'The planner action is outside the trusted surface policy.',
  PLANNER_NO_DECISION: 'The planner returned no typed decision.',
  PLANNER_TYPED_DECISION_REQUIRED: 'The planner returned no typed capability decision.',
  PLANNER_FAILED: 'The planner request failed at the typed runtime boundary.',
  INVALID_ACTION: 'The planner action failed contract validation.',
  INVALID_EVENT: 'The planner event failed contract validation.',
  CONTEXT_MISMATCH: 'The request context does not match the trusted task.',
  WORKSPACE_MISMATCH: 'The request workspace does not match the trusted task.',
  ACTION_CONFLICT: 'The request conflicts with the durable action checkpoint.',
  STALE_REVISION: 'The request revision is stale.',
  OPERATION_LIMIT_REACHED: 'The task operation limit has been reached.',
  AVAILABILITY_TERMINAL_POLICY_OWNED: 'Availability policy owns the terminal decision.',
  TRUSTED_INGRESS_BINDING_REQUIRED: 'A trusted ingress binding is required.',
  INVALID_INGRESS_BINDING: 'The trusted ingress binding is invalid.',
  BOOKING_SURFACE_SCHEMA_MISMATCH: 'The booking surface schema is not supported.',
  UNAUTHORIZED: 'The request is not authorized.',
  NOT_FOUND: 'The requested resource was not found.',
}

function rawCode(error: unknown): string {
  if (typeof error === 'string') return error.split(':', 1)[0]!
  if (error instanceof Error && error.message) return error.message.split(':', 1)[0]!
  return 'planner_failed'
}

export function normalizeBookingErrorCode(error: unknown): BookingTypedErrorCode {
  const raw = rawCode(error)
  const normalized = raw.trim().toLowerCase()
  const aliased = ALIASES[normalized]
  if (aliased) return aliased
  const uppercase = raw.trim().replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()
  return (BOOKING_TYPED_ERROR_CODES as readonly string[]).includes(uppercase)
    ? uppercase as BookingTypedErrorCode
    : 'PLANNER_FAILED'
}

export function safeBookingErrorMessage(code: string): string {
  return SAFE_MESSAGES[(BOOKING_TYPED_ERROR_CODES as readonly string[]).includes(code) ? code as BookingTypedErrorCode : 'PLANNER_FAILED']
}
