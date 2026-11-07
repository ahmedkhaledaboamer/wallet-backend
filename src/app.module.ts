import { Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { CoreModule } from "./core.module";
import type { AppConfig } from "./infrastructure/config/env";
import { AuthGuard, RolesGuard } from "./interface/http/auth";
import { AuditController, BatchesController, DashboardController, SystemController } from "./interface/http/controllers";
import { ApiExceptionFilter } from "./interface/http/exception.filter";

@Module({})
export class ApiModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ApiModule,
      imports: [CoreModule.forRoot(config)],
      controllers: [SystemController, DashboardController, BatchesController, AuditController],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard }, // authentication first …
        { provide: APP_GUARD, useClass: RolesGuard }, // … then role checks (403)
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ],
    };
  }
}

/** Builds the configured HTTP app (used by main.ts and the integration tests). */
export async function createApiApp(config: AppConfig, opts: { logger?: false } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(ApiModule.forRoot(config), { logger: opts.logger ?? ["log", "warn", "error"] });
  app.setGlobalPrefix("api");
  app.enableCors({
    origin: config.env.CORS_ORIGIN.split(",").map((o) => o.trim()),
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type"],
    exposedHeaders: ["Content-Disposition"],
  });
  const doc = new DocumentBuilder()
    .setTitle("Batch Payout API")
    .setDescription("One-click batch crypto payouts (TESTNET / DRY-RUN). All amounts are decimal strings, except /onchain-payload (base units).")
    .setVersion("1.0")
    .addBearerAuth()
    .addServer("/")
    .build();
  SwaggerModule.setup("docs", app, () => SwaggerModule.createDocument(app, doc));
  app.enableShutdownHooks();
  return app;
}
