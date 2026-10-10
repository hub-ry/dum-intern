// The one error type the workshop raises for callers: a status the HTTP layer can pass through
// and a message safe to show. 400 is bad input, 404 an unknown record, 409 a conflict with the
// store's current state, 500 a store that can't be trusted (corrupt files, closed, I/O failure).

export type WorkshopErrorStatus = 400 | 404 | 409 | 500;

export class WorkshopError extends Error {
  readonly status: WorkshopErrorStatus;

  constructor(status: WorkshopErrorStatus, message: string) {
    super(message);
    this.name = "WorkshopError";
    this.status = status;
  }

  static invalid(message: string): WorkshopError {
    return new WorkshopError(400, message);
  }

  static notFound(message: string): WorkshopError {
    return new WorkshopError(404, message);
  }

  static conflict(message: string): WorkshopError {
    return new WorkshopError(409, message);
  }

  static corrupt(message: string): WorkshopError {
    return new WorkshopError(500, message);
  }
}
