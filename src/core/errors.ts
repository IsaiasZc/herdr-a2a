/**
 * Structured, stable error taxonomy (spec §27).
 *
 * Codes are part of the layer's public contract: the thin CLI, the A2A error
 * mapping and the tests all key off them. Never rename one without a migration.
 */

export const ERROR_CODES = {
  // Discovery
  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  AGENT_NOT_LAUNCHABLE: "AGENT_NOT_LAUNCHABLE",
  CUSTOM_AGENT_NOT_FOUND: "CUSTOM_AGENT_NOT_FOUND",
  CUSTOM_AGENT_RUNTIME_UNAVAILABLE: "CUSTOM_AGENT_RUNTIME_UNAVAILABLE",

  // Herdr
  HERDR_UNAVAILABLE: "HERDR_UNAVAILABLE",
  HERDR_PROTOCOL_UNSUPPORTED: "HERDR_PROTOCOL_UNSUPPORTED",
  HERDR_API_ERROR: "HERDR_API_ERROR",
  HERDR_SESSION_STALE: "HERDR_SESSION_STALE",

  // Spawn / layout
  PANE_ALLOCATION_FAILED: "PANE_ALLOCATION_FAILED",
  LAYOUT_TOO_SMALL: "LAYOUT_TOO_SMALL",
  RUNTIME_START_FAILED: "RUNTIME_START_FAILED",
  RUNTIME_START_TIMEOUT: "RUNTIME_START_TIMEOUT",
  RUNTIME_NOT_DETECTED: "RUNTIME_NOT_DETECTED",
  RUNTIME_CRASHED: "RUNTIME_CRASHED",

  // Relay
  DELIVERY_EXPIRED: "DELIVERY_EXPIRED",
  DELIVERY_TARGET_BUSY: "DELIVERY_TARGET_BUSY",
  DELIVERY_TARGET_BLOCKED: "DELIVERY_TARGET_BLOCKED",
  DELIVERY_FAILED: "DELIVERY_FAILED",
  TURN_DID_NOT_START: "TURN_DID_NOT_START",
  QUEUE_FULL: "QUEUE_FULL",
  RELAY_MESSAGE_NOT_FOUND: "RELAY_MESSAGE_NOT_FOUND",

  // Options
  MODEL_UNSUPPORTED: "MODEL_UNSUPPORTED",
  INVALID_EXECUTION_OPTION: "INVALID_EXECUTION_OPTION",
  INVALID_CWD: "INVALID_CWD",
  RUNTIME_VERSION_UNSUPPORTED: "RUNTIME_VERSION_UNSUPPORTED",

  // Task
  TASK_TIMEOUT: "TASK_TIMEOUT",
  TASK_FAILED: "TASK_FAILED",
  TASK_CANCELED: "TASK_CANCELED",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  RESULT_UNAVAILABLE: "RESULT_UNAVAILABLE",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  INPUT_REQUIRED: "INPUT_REQUIRED",

  // Identity / reconciliation
  TARGET_IDENTITY_CHANGED: "TARGET_IDENTITY_CHANGED",
  TARGET_LOST: "TARGET_LOST",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface DelegationError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/** Codes that a bounded recovery pass is allowed to retry. */
const RETRYABLE: ReadonlySet<string> = new Set<ErrorCode>([
  ERROR_CODES.HERDR_UNAVAILABLE,
  ERROR_CODES.HERDR_SESSION_STALE,
  ERROR_CODES.PANE_ALLOCATION_FAILED,
  ERROR_CODES.RUNTIME_START_TIMEOUT,
  ERROR_CODES.RUNTIME_NOT_DETECTED,
  ERROR_CODES.DELIVERY_TARGET_BUSY,
  ERROR_CODES.TURN_DID_NOT_START,
]);

export class DelegationFailure extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>, retryable?: boolean) {
    super(message);
    this.name = "DelegationFailure";
    this.code = code;
    this.retryable = retryable ?? RETRYABLE.has(code);
    if (details !== undefined) this.details = details;
  }

  toJSON(): DelegationError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function fail(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): DelegationFailure {
  return new DelegationFailure(code, message, details);
}

/** Normalize anything thrown into the taxonomy so callers never see raw errors. */
export function toDelegationError(err: unknown, fallback: ErrorCode = ERROR_CODES.TASK_FAILED): DelegationError {
  if (err instanceof DelegationFailure) return err.toJSON();
  const message = err instanceof Error ? err.message : String(err);
  return { code: fallback, message, retryable: RETRYABLE.has(fallback) };
}

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE.has(code);
}
