// Typed application errors with stable machine-readable error codes.
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RANGE_ERROR"
  | "UNIDENTIFIABLE"
  | "IDEMPOTENCY_REPLAY"
  | "BAD_STATE";

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function validation(message: string, details?: unknown): never {
  throw new AppError("VALIDATION_ERROR", message, details);
}
