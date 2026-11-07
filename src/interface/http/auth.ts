import { createHash } from "node:crypto";
import { Inject, Injectable, SetMetadata, createParamDecorator, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { ForbiddenError, UnauthenticatedError } from "../../domain/errors";
import type { Role } from "../../domain/network";
import { PAYOUT_REPOSITORY, type PayoutRepository, type UserRecord } from "../../domain/ports/payout-repository";

export const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

const PUBLIC_KEY = "auth:public";
const ROLES_KEY = "auth:roles";

/** Route needs no bearer token. */
export const Public = () => SetMetadata(PUBLIC_KEY, true);
/** Route requires one of these roles (403 otherwise). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

type AuthedRequest = Request & { user?: UserRecord };

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): UserRecord => {
  const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
  if (!user) throw new UnauthenticatedError();
  return user;
});

/**
 * Bearer tokens are looked up by sha256 hash — the database never stores a usable token.
 * Every route is authenticated unless marked @Public().
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PAYOUT_REPOSITORY) private readonly repo: PayoutRepository,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization ?? "";
    const m = /^Bearer\s+(\S{16,512})$/i.exec(header);
    if (!m) throw new UnauthenticatedError();
    const user = await this.repo.findUserByTokenHash(hashToken(m[1]!));
    if (!user) throw new UnauthenticatedError();
    req.user = user;
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const user = ctx.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user) throw new UnauthenticatedError();
    if (!roles.includes(user.role)) {
      throw new ForbiddenError(`This action requires the ${roles.join(" or ")} role; you are ${user.role}.`);
    }
    return true;
  }
}
