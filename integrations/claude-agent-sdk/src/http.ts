/**
 * Low-level HTTP client using the global fetch API (Node 18+).
 * Translates API error status codes into typed ImpriError subclasses.
 */

import {
  ImpriApiError,
  ImpriConflict,
  ImpriExpired,
  ImpriNotFound,
  ImpriQuotaExceeded,
  ImpriRateLimited,
  ImpriUnauthorized,
  ImpriValidationError,
} from "./errors.js";

export interface HttpConfig {
  apiKey: string;
  baseUrl: string;
}

/**
 * Execute an authenticated request against the Impri API.
 * The base URL must not include /v1; it is prepended automatically.
 */
export async function apiRequest<T>(
  config: HttpConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${config.baseUrl}/v1${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url, init);

  if (res.status === 204) {
    return {} as T;
  }

  if (!res.ok) {
    await throwApiError(res);
  }

  return res.json() as Promise<T>;
}

async function throwApiError(res: Response): Promise<never> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Response body not parseable as JSON — use an empty object.
  }

  const message =
    (body["message"] as string | undefined) ??
    (body["error"] as string | undefined) ??
    res.statusText;

  switch (res.status) {
    case 401:
    case 403:
      throw new ImpriUnauthorized(
        `Authentication failed (${res.status}): ${message}`,
        res.status,
        body,
      );

    case 404:
      throw new ImpriNotFound(`Not found: ${message}`, body);

    case 409:
      throw new ImpriConflict(`Conflict: ${message}`, body);

    case 410:
      throw new ImpriExpired(`Expired: ${message}`, body);

    case 429: {
      const retryAfterRaw = res.headers.get("Retry-After");
      const retryAfter = retryAfterRaw ? parseInt(retryAfterRaw, 10) : undefined;
      throw new ImpriRateLimited(`Rate limited: ${message}`, body, retryAfter);
    }

    case 402:
      throw new ImpriQuotaExceeded(`Quota exceeded: ${message}`, body);

    case 400:
    case 422: {
      const issues = Array.isArray(body["issues"]) ? (body["issues"] as unknown[]) : [];
      throw new ImpriValidationError(
        `Validation error (${res.status}): ${message}`,
        res.status,
        body,
        issues,
      );
    }

    default:
      throw new ImpriApiError(
        `Impri API error ${res.status}: ${message}`,
        res.status,
        body,
      );
  }
}
