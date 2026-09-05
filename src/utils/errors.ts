/** Base class for errors whose message is safe to show to an operator. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code: string = 'APP_ERROR',
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The requested state transition is not allowed by IncidentStateService. */
export class InvalidTransitionError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'INVALID_TRANSITION', details);
  }
}

/** Another operator already performed this action (lost an optimistic race). */
export class ConflictError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'CONFLICT', details);
  }
}

/** The actor lacks the role/permission required for this action. */
export class ForbiddenError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'FORBIDDEN', details);
  }
}

export class NotFoundError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'NOT_FOUND', details);
  }
}

/** User-input validation failure (too long text, video attachment, ...). */
export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION', details);
  }
}

/** Daily incident quota exhausted. */
export class RateLimitError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'RATE_LIMIT', details);
  }
}

const EXPECTED_USER_CODES = new Set(['VALIDATION', 'FORBIDDEN', 'CONFLICT', 'INVALID_TRANSITION', 'NOT_FOUND', 'RATE_LIMIT', 'BAD_PAYLOAD']);

export function isExpectedUserError(error: unknown): error is AppError {
  return error instanceof AppError && EXPECTED_USER_CODES.has(error.code);
}

/** Show feedback, but preserve technical failures for the durable inbox. */
export async function reportActionError(error: unknown, notify: () => Promise<unknown>): Promise<void> {
  try {
    await notify();
  } catch (feedbackError) {
    if (isExpectedUserError(error)) throw feedbackError;
  }
  if (!isExpectedUserError(error)) throw error;
}
