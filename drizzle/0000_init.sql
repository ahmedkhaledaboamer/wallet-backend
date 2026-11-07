CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" uuid,
	"action" text NOT NULL,
	"actor_id" text,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "batch_items" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"reference" text NOT NULL,
	"address" text NOT NULL,
	"amount" numeric(36, 18) NOT NULL,
	"memo" text,
	"status" text NOT NULL,
	"provider_reference" text,
	"failure_reason" text,
	"tx_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sending" boolean DEFAULT false NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"asset" text NOT NULL,
	"network" text NOT NULL,
	"total_amount" numeric(36, 18) NOT NULL,
	"item_count" integer NOT NULL,
	"paid_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"reconciliation_count" integer DEFAULT 0 NOT NULL,
	"file_sha256" text NOT NULL,
	"file_name" text NOT NULL,
	"created_by_id" text NOT NULL,
	"approved_by_id" text,
	"executed_by_id" text,
	"rejection_reason" text,
	"tx_hash" text,
	"simulated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"approved_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batch_items" ADD CONSTRAINT "batch_items_batch_id_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_approved_by_id_users_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "batches" ADD CONSTRAINT "batches_executed_by_id_users_id_fk" FOREIGN KEY ("executed_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_batch_idx" ON "audit_log" USING btree ("batch_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "batch_items_batch_status_idx" ON "batch_items" USING btree ("batch_id","status");--> statement-breakpoint
CREATE INDEX "batch_items_batch_row_idx" ON "batch_items" USING btree ("batch_id","row_number");--> statement-breakpoint
CREATE UNIQUE INDEX "batch_items_batch_reference_uq" ON "batch_items" USING btree ("batch_id",upper("reference"));--> statement-breakpoint
CREATE UNIQUE INDEX "batches_file_sha256_active_uq" ON "batches" USING btree ("file_sha256") WHERE "batches"."status" <> 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX "batches_tx_hash_uq" ON "batches" USING btree ("tx_hash") WHERE "batches"."tx_hash" is not null;--> statement-breakpoint
CREATE INDEX "batches_status_idx" ON "batches" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "batches_channel_idx" ON "batches" USING btree ("channel","created_at");