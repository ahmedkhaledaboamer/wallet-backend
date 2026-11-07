import { Catch, HttpException, Logger, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { DomainError, type RowError } from "../../domain/errors";
import { fileError } from "../../domain/withdrawal-rules";

const STATUS = { unauthenticated: 401, forbidden: 403, not_found: 404, illegal_state: 409, validation: 422, policy: 422 } as const;

export interface ErrorBody {
  message: string;
  code: string;
  errors?: RowError[];
}

/** Every error leaves the API as { message, code, errors? } — the contract's error shape. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger("Http");

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const [status, body] = this.map(exception);
    if (status >= 500) this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    res.status(status).json(body);
  }

  private map(e: unknown): [number, ErrorBody] {
    if (e instanceof DomainError) {
      const body: ErrorBody = { message: e.message, code: e.code };
      if ("errors" in e && Array.isArray(e.errors) && e.errors.length) body.errors = e.errors as RowError[];
      return [STATUS[e.kind], body];
    }
    // Multer: file over the hard upload limit.
    if (e && typeof e === "object" && (e as { code?: string }).code === "LIMIT_FILE_SIZE") {
      return [422, { message: "The withdrawal list has validation errors.", code: "VALIDATION_FAILED", errors: [fileError("file.too_large", { size: "unknown", max: "configured limit" })] }];
    }
    if (e instanceof HttpException) {
      const status = e.getStatus();
      const r = e.getResponse();
      const message = typeof r === "string" ? r : Array.isArray((r as { message?: unknown }).message) ? ((r as { message: string[] }).message).join("; ") : String((r as { message?: unknown }).message ?? e.message);
      const code = status === 404 ? "NOT_FOUND" : status === 413 ? "PAYLOAD_TOO_LARGE" : status === 400 ? "BAD_REQUEST" : `HTTP_${status}`;
      return [status === 400 ? 422 : status, { message, code }];
    }
    return [500, { message: "Internal server error", code: "INTERNAL" }];
  }
}
