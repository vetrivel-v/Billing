import { ErrorCodes, type ErrorCode } from '@commercebill/shared-types';

/**
 * An error whose HTTP status, stable code and user-safe message are decided by application code.
 * The global error handler returns exactly these three facts (plus the correlation ID) and logs the rest.
 */
export class ApiHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly apiCode: ErrorCode,
    message: string,
    readonly problems?: { field: string; rule: string }[],
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

/** 401: no valid authenticated identity. Deliberately one message for every reason. */
export const unauthenticated = () =>
  new ApiHttpError(401, ErrorCodes.UNAUTHENTICATED, 'Authentication is required.');

/** 403: authenticated, but lacking the required permission. */
export const forbidden = () =>
  new ApiHttpError(403, ErrorCodes.FORBIDDEN, 'You do not have permission to perform this action.');

export const serviceUnavailable = () =>
  new ApiHttpError(
    503,
    ErrorCodes.DATABASE_UNAVAILABLE,
    'The service is not available. No data was changed.',
  );
