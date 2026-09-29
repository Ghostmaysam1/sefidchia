-- CreateTable
CREATE TABLE "rotation_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "interval_ms" BIGINT NOT NULL DEFAULT 7200000,
    "cycle_started_at" TIMESTAMPTZ(3),
    "next_rotation_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rotation_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channels" (
    "id" VARCHAR(128) NOT NULL,
    "discussion_group_id" VARCHAR(128),
    "current_admin_user_id" BIGINT,
    "forced_next_user_id" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "channel_id" VARCHAR(128) NOT NULL,
    "user_id" BIGINT NOT NULL,
    "post_date" TIMESTAMPTZ(3) NOT NULL,
    "comment_date" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("channel_id","user_id","post_date")
);

-- CreateIndex
CREATE UNIQUE INDEX "channels_discussion_group_id_key" ON "channels"("discussion_group_id");

-- CreateIndex
CREATE INDEX "candidates_channel_id_comment_date_idx" ON "candidates"("channel_id", "comment_date");

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
