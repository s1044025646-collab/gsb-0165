/** 统一错误码。API 层据此返回 HTTP 状态，CLI 据此打印可读原因。 */
export type ErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'SOC_OUT_OF_RANGE'
  | 'TIME_NOT_MONOTONIC'
  | 'OCV_TABLE_INSUFFICIENT'
  | 'NON_POSITIVE_PARAM'
  | 'NOT_IDENTIFIABLE'
  | 'BAD_REQUEST'
  | 'INTERNAL';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export function httpStatus(code: ErrorCode): number {
  switch (code) {
    case 'NOT_FOUND':
      return 404;
    case 'CONFLICT':
      return 409;
    case 'NOT_IDENTIFIABLE':
      return 422;
    case 'VALIDATION':
    case 'SOC_OUT_OF_RANGE':
    case 'TIME_NOT_MONOTONIC':
    case 'OCV_TABLE_INSUFFICIENT':
    case 'NON_POSITIVE_PARAM':
    case 'BAD_REQUEST':
      return 400;
    default:
      return 500;
  }
}
