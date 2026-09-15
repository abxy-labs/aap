export type ErrorType = "invalid_request_error" | "authentication_error" | "permission_error" | "idempotency_error" | "api_error";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: ErrorType,
    public readonly code: string,
    message: string,
    public readonly param?: string,
  ) {
    super(message);
  }
}

export function invalid(code: string, message: string, param?: string): ApiError {
  return new ApiError(400, "invalid_request_error", code, message, param);
}

export function notFound(resource: string, id: string): ApiError {
  return new ApiError(404, "invalid_request_error", "resource_missing", `No such ${resource}: '${id}'.`, "id");
}

export function forbidden(message: string): ApiError {
  return new ApiError(403, "permission_error", "permission_denied", message);
}

export function unauthenticated(message: string): ApiError {
  return new ApiError(401, "authentication_error", "invalid_api_key", message);
}
