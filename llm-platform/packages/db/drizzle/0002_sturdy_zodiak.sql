CREATE TABLE "chunk_entities" (
	"chunk_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"mentions" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chunk_entities_chunk_id_entity_id_pk" PRIMARY KEY("chunk_id","entity_id")
);
--> statement-breakpoint
CREATE TABLE "chunk_extractions" (
	"chunk_id" uuid PRIMARY KEY NOT NULL,
	"prompt_version" text NOT NULL,
	"entity_count" integer DEFAULT 0 NOT NULL,
	"relation_count" integer DEFAULT 0 NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "edge_chunks" (
	"edge_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	CONSTRAINT "edge_chunks_edge_id_chunk_id_pk" PRIMARY KEY("edge_id","chunk_id")
);
--> statement-breakpoint
CREATE TABLE "edges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_entity_id" uuid NOT NULL,
	"target_entity_id" uuid NOT NULL,
	"relation" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb,
	"confidence" real DEFAULT 1 NOT NULL,
	"origin" text DEFAULT 'llm' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"type" text NOT NULL,
	"summary" text,
	"embedding" vector(1536),
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"alias" text NOT NULL,
	"normalized_alias" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunk_entities" ADD CONSTRAINT "chunk_entities_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_entities" ADD CONSTRAINT "chunk_entities_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunk_extractions" ADD CONSTRAINT "chunk_extractions_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_chunks" ADD CONSTRAINT "edge_chunks_edge_id_edges_id_fk" FOREIGN KEY ("edge_id") REFERENCES "public"."edges"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edge_chunks" ADD CONSTRAINT "edge_chunks_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_source_entity_id_entities_id_fk" FOREIGN KEY ("source_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edges" ADD CONSTRAINT "edges_target_entity_id_entities_id_fk" FOREIGN KEY ("target_entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chunk_entities_entity_id_idx" ON "chunk_entities" USING btree ("entity_id");--> statement-breakpoint
CREATE INDEX "edge_chunks_chunk_id_idx" ON "edge_chunks" USING btree ("chunk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "edges_triple_idx" ON "edges" USING btree ("source_entity_id","relation","target_entity_id");--> statement-breakpoint
CREATE INDEX "edges_source_idx" ON "edges" USING btree ("source_entity_id");--> statement-breakpoint
CREATE INDEX "edges_target_idx" ON "edges" USING btree ("target_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entities_normalized_name_type_idx" ON "entities" USING btree ("normalized_name","type");--> statement-breakpoint
CREATE INDEX "entities_type_idx" ON "entities" USING btree ("type");--> statement-breakpoint
CREATE INDEX "entities_embedding_hnsw_idx" ON "entities" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "entity_aliases_alias_entity_idx" ON "entity_aliases" USING btree ("normalized_alias","entity_id");--> statement-breakpoint
CREATE INDEX "entity_aliases_normalized_idx" ON "entity_aliases" USING btree ("normalized_alias");