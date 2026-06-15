-- AlterTable
ALTER TABLE "heatmap_snapshot" ALTER COLUMN "created_at" DROP NOT NULL;

-- CreateTable
CREATE TABLE "heatmap_replay_preview" (
    "preview_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "visit_id" UUID NOT NULL,
    "url_path" VARCHAR(500) NOT NULL,
    "viewport_w" INTEGER NOT NULL,
    "viewport_h" INTEGER NOT NULL,
    "replay_chunk_index" INTEGER NOT NULL,
    "replay_event_index" INTEGER NOT NULL,
    "replay_time_ms" BIGINT,
    "created_at" TIMESTAMPTZ(6) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6),

    CONSTRAINT "heatmap_replay_preview_pkey" PRIMARY KEY ("preview_id")
);

-- CreateIndex
CREATE INDEX "heatmap_replay_preview_website_id_idx" ON "heatmap_replay_preview"("website_id");

-- CreateIndex
CREATE INDEX "heatmap_replay_preview_visit_id_idx" ON "heatmap_replay_preview"("visit_id");

-- CreateIndex
CREATE INDEX "heatmap_replay_preview_website_id_url_path_idx" ON "heatmap_replay_preview"("website_id", "url_path");

-- CreateIndex
CREATE UNIQUE INDEX "heatmap_replay_preview_website_id_url_path_viewport_w_viewp_key" ON "heatmap_replay_preview"("website_id", "url_path", "viewport_w", "viewport_h");

-- CreateIndex
CREATE INDEX "session_replay_visit_id_idx" ON "session_replay"("visit_id");

-- RenameIndex
ALTER INDEX "heatmap_event_website_id_visit_id_replay_chunk_index_replay_eve" RENAME TO "heatmap_event_website_id_visit_id_replay_chunk_index_replay_idx";
