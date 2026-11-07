import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiParam, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { memoryStorage } from "multer";
import { ConfirmOnchainBatch } from "../../application/confirm-onchain-batch";
import { ExecuteBatch } from "../../application/execute-batch";
import { ImportWithdrawalSheet } from "../../application/import-withdrawal-sheet";
import { PrepareOnchainBatch } from "../../application/prepare-onchain-batch";
import { PayoutQueries } from "../../application/queries";
import { ReviewBatch } from "../../application/review-batch";
import { APP_SETTINGS, type AppSettings } from "../../application/settings";
import { ValidateWithdrawalSheet, type UploadedFile as Upload } from "../../application/validate-withdrawal-sheet";
import { NotFoundError, ValidationError } from "../../domain/errors";
import type { UserRecord } from "../../domain/ports/payout-repository";
import { sql } from "drizzle-orm";
import { APP_CONFIG, DB_HANDLE } from "../../core.module";
import type { DbHandle } from "../../infrastructure/db/client";
import type { AppConfig } from "../../infrastructure/config/env";
import { DEMO_USERS } from "../../infrastructure/db/demo-users";
import { buildWithdrawalWorkbook } from "../../infrastructure/xlsx/template";
import { CurrentUser, Public, Roles } from "./auth";
import { presentAudit, presentBatch, presentConfig, presentDashboard, presentItem, presentValidation, page } from "./presenters";
import { auditListQuery, batchListQuery, channelField, itemListQuery, parseOr422, uuidParam } from "./query";

/** Hard transport cap; the configured MAX_FILE_BYTES (2 MB) is enforced by the use case with a row-0 error. */
const UPLOAD = FileInterceptor("file", { storage: memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 5 } });

const uploadBody = {
  schema: {
    type: "object",
    required: ["file", "channel"],
    properties: { file: { type: "string", format: "binary" }, channel: { type: "string", enum: ["mexc", "trust_wallet"] } },
  },
};

function toUpload(file: Express.Multer.File | undefined): Upload {
  if (!file?.buffer) throw new ValidationError("A .xlsx file is required in the 'file' field.", [], "FILE_REQUIRED");
  return { name: file.originalname || "upload.xlsx", bytes: new Uint8Array(file.buffer.buffer, file.buffer.byteOffset, file.buffer.byteLength) };
}

/** Non-UUID ids can't exist: answer 404 instead of letting Postgres reject the cast. */
function batchId(id: string): string {
  if (!uuidParam.safeParse(id).success) throw new NotFoundError("Batch", id);
  return id.toLowerCase();
}

@ApiTags("system")
@Controller()
export class SystemController {
  constructor(
    @Inject(APP_SETTINGS) private readonly settings: AppSettings,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DB_HANDLE) private readonly db: DbHandle,
  ) {}

  @Public()
  @Get("health")
  @ApiOperation({ summary: "Liveness + database check (public)" })
  async health() {
    await this.db.db.execute(sql`select 1`); // throws → 500 if the database is unreachable
    return { status: "ok", database: "up", environment: "testnet", dryRun: this.settings.dryRun };
  }

  @Public()
  @Get("config")
  @ApiOperation({ summary: "Environment, networks and limits (public)" })
  getConfig() {
    return presentConfig(this.settings);
  }

  @Public()
  @Get("demo/users")
  @ApiOperation({ summary: "Demo users with bearer tokens (only when DEMO_AUTH=true)" })
  demoUsers() {
    if (!this.config.env.DEMO_AUTH) throw new NotFoundError("Route", "/demo/users");
    return DEMO_USERS.map(({ id, name, role, token }) => ({ id, name, role, token }));
  }

  @Get("me")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Current user" })
  me(@CurrentUser() user: UserRecord) {
    return { id: user.id, name: user.name, role: user.role };
  }

  @Get("templates/withdrawals.xlsx")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Excel withdrawal template" })
  async template(@Res() res: Response) {
    const bytes = await buildWithdrawalWorkbook([], { example: true });
    res
      .status(200)
      .setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .setHeader("Content-Disposition", 'attachment; filename="withdrawals-template.xlsx"')
      .send(Buffer.from(bytes));
  }
}

@ApiTags("dashboard")
@ApiBearerAuth()
@Controller("dashboard")
export class DashboardController {
  constructor(@Inject(PayoutQueries) private readonly queries: PayoutQueries) {}

  @Get("stats")
  async stats() {
    return presentDashboard(await this.queries.dashboard());
  }
}

@ApiTags("batches")
@ApiBearerAuth()
@Controller("batches")
export class BatchesController {
  constructor(
    @Inject(APP_SETTINGS) private readonly settings: AppSettings,
    @Inject(PayoutQueries) private readonly queries: PayoutQueries,
    @Inject(ValidateWithdrawalSheet) private readonly validateSheet: ValidateWithdrawalSheet,
    @Inject(ImportWithdrawalSheet) private readonly importSheet: ImportWithdrawalSheet,
    @Inject(ReviewBatch) private readonly review: ReviewBatch,
    @Inject(ExecuteBatch) private readonly executeBatch: ExecuteBatch,
    @Inject(PrepareOnchainBatch) private readonly prepare: PrepareOnchainBatch,
    @Inject(ConfirmOnchainBatch) private readonly confirm: ConfirmOnchainBatch,
  ) {}

  @Post("validate")
  @HttpCode(200)
  @Roles("maker")
  @UseInterceptors(UPLOAD)
  @ApiConsumes("multipart/form-data")
  @ApiBody(uploadBody)
  @ApiOperation({ summary: "Validate a withdrawal list without storing it" })
  async validate(@UploadedFile() file: Express.Multer.File | undefined, @Body("channel") channel: unknown) {
    const ch = parseOr422(channelField, channel, "channel");
    return presentValidation(await this.validateSheet.execute(toUpload(file), ch));
  }

  @Post()
  @HttpCode(201)
  @Roles("maker")
  @UseInterceptors(UPLOAD)
  @ApiConsumes("multipart/form-data")
  @ApiBody(uploadBody)
  @ApiOperation({ summary: "Import a withdrawal list as a draft batch (all-or-nothing)" })
  @ApiResponse({ status: 201, description: "Draft batch created (Batch)" })
  @ApiResponse({ status: 422, description: "Validation errors: { message, code, errors: [{ row, messages, issues }] }" })
  async create(@CurrentUser() user: UserRecord, @UploadedFile() file: Express.Multer.File | undefined, @Body("channel") channel: unknown) {
    const ch = parseOr422(channelField, channel, "channel");
    return presentBatch(await this.importSheet.execute(user, toUpload(file), ch), this.settings);
  }

  @Get()
  @ApiOperation({ summary: "List batches (filter by status, channel)" })
  async list(@Query() query: Record<string, unknown>) {
    const q = parseOr422(batchListQuery, query, "query");
    const r = await this.queries.listBatches(q);
    return page(r.data.map((b) => presentBatch(b, this.settings)), q, r.total);
  }

  @Get(":id")
  @ApiParam({ name: "id", format: "uuid" })
  async get(@Param("id") id: string) {
    return presentBatch(await this.queries.getBatch(batchId(id)), this.settings);
  }

  @Get(":id/items")
  async items(@Param("id") id: string, @Query() query: Record<string, unknown>) {
    const q = parseOr422(itemListQuery, query, "query");
    const { batch, page: r } = await this.queries.listItems(batchId(id), q);
    return page(r.data.map((i) => presentItem(i, batch, this.settings)), q, r.total);
  }

  @Get(":id/audit")
  async audit(@Param("id") id: string) {
    return (await this.queries.batchAudit(batchId(id))).map(presentAudit);
  }

  @Post(":id/approve")
  @HttpCode(200)
  @Roles("checker")
  @ApiOperation({ summary: "Approve a draft batch (four-eyes: not by its maker)" })
  async approve(@CurrentUser() user: UserRecord, @Param("id") id: string) {
    return presentBatch(await this.review.approve(user, batchId(id)), this.settings);
  }

  @Post(":id/reject")
  @HttpCode(200)
  @Roles("checker")
  @ApiBody({ schema: { type: "object", required: ["reason"], properties: { reason: { type: "string", minLength: 5 } } } })
  async reject(@CurrentUser() user: UserRecord, @Param("id") id: string, @Body() body: { reason?: unknown } | undefined) {
    return presentBatch(await this.review.reject(user, batchId(id), body?.reason), this.settings);
  }

  @Post(":id/execute")
  @HttpCode(202)
  @Roles("executor")
  @ApiOperation({ summary: "Pay a MEXC batch (approved → processing exactly once; 409 on repeat)" })
  async execute(@CurrentUser() user: UserRecord, @Param("id") id: string) {
    return presentBatch(await this.executeBatch.execute(user, batchId(id)), this.settings);
  }

  @Get(":id/onchain-payload")
  @Roles("executor")
  @ApiOperation({ summary: "Trust Wallet payload; amounts/total are RAW token base units" })
  onchainPayload(@CurrentUser() user: UserRecord, @Param("id") id: string) {
    return this.prepare.execute(user, batchId(id));
  }

  @Post(":id/transaction")
  @HttpCode(202)
  @Roles("executor")
  @ApiBody({ schema: { type: "object", required: ["txHash"], properties: { txHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" } } } })
  async transaction(@CurrentUser() user: UserRecord, @Param("id") id: string, @Body() body: { txHash?: unknown } | undefined) {
    return presentBatch(await this.confirm.submit(user, batchId(id), body?.txHash), this.settings);
  }
}

@ApiTags("audit")
@ApiBearerAuth()
@Controller("audit")
export class AuditController {
  constructor(@Inject(PayoutQueries) private readonly queries: PayoutQueries) {}

  @Get()
  async list(@Query() query: Record<string, unknown>) {
    const q = parseOr422(auditListQuery, query, "query");
    if (q.batchId && !uuidParam.safeParse(q.batchId).success) return page([], q, 0);
    const r = await this.queries.listAudit(q);
    return page(r.data.map(presentAudit), q, r.total);
  }
}
