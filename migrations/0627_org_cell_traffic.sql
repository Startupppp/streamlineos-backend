CREATE TABLE IF NOT EXISTS "organization_cell_traffic" (
  "org_id" TEXT NOT NULL,
  "cell_id" TEXT NOT NULL,
  "request_count" BIGINT NOT NULL DEFAULT 0,
  "window_start" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "last_seen_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "organization_cell_traffic_pkey" PRIMARY KEY ("org_id", "cell_id")
);
