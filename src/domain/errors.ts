/**
 * Domain errors. The HTTP layer maps each `kind` to a status code:
 * unauthenticated 401 · forbidden 403 · not_found 404 · illegal_state 409 · validation/policy 422.
 */
export type IssueCode =
  | "address.invalid"
  | "amount.not_positive"
  | "amount.zero"
  | "amount.too_precise"
  | "amount.not_number"
  | "amount.below_minimum"
  | "reference.duplicate"
  | "reference.required"
  | "asset.unsupported"
  | "network.unsupported"
  | "network.unsupported_for_channel"
  | "file.missing_columns"
  | "file.empty"
  | "file.duplicate"
  | "file.mixed_network"
  | "file.too_many_rows"
  | "file.too_large"
  | "file.unreadable"
  | "batch.total_exceeds_limit";

export type IssueParams = Record<string, string | number | string[]>;

export interface Issue {
  code: IssueCode;
  params?: IssueParams;
}

/** One entry per Excel row (row 0 = whole file). messages[i] is the English text for issues[i]. */
export interface RowError {
  row: number;
  messages: string[];
  issues: Issue[];
}

export type DomainErrorKind = "unauthenticated" | "forbidden" | "not_found" | "illegal_state" | "validation" | "policy";

export abstract class DomainError extends Error {
  abstract readonly kind: DomainErrorKind;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class UnauthenticatedError extends DomainError {
  readonly kind = "unauthenticated" as const;
  constructor(message = "Missing or invalid bearer token") {
    super("UNAUTHENTICATED", message);
  }
}

export class ForbiddenError extends DomainError {
  readonly kind = "forbidden" as const;
  constructor(message = "Your role cannot perform this action", code = "FORBIDDEN_ROLE") {
    super(code, message);
  }
}

export class NotFoundError extends DomainError {
  readonly kind = "not_found" as const;
  constructor(what: string, id: string) {
    super("NOT_FOUND", `${what} ${id} not found`);
  }
}

export class IllegalStateError extends DomainError {
  readonly kind = "illegal_state" as const;
  constructor(message: string, code = "ILLEGAL_STATE") {
    super(code, message);
  }
}

/** 422 with row-level errors (Excel validation). */
export class ValidationError extends DomainError {
  readonly kind = "validation" as const;
  constructor(
    message: string,
    readonly errors: RowError[] = [],
    code = "VALIDATION_FAILED",
  ) {
    super(code, message);
  }
}

/** 422 business-rule violation (four-eyes, channel mismatch, limits…). */
export class PolicyViolationError extends DomainError {
  readonly kind = "policy" as const;
  constructor(code: string, message: string) {
    super(code, message);
  }
}
