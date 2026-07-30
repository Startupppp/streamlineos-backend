SET statement_timeout = 0;

-- =============================================================================
-- 0367 — drop 5 dead user_preferences columns
-- =============================================================================
-- accent_color / density / font_size / reduced_motion / high_contrast were
-- writable through PATCH /users/:id/preferences and declared on the frontend
-- UserPreferences type, but NOTHING ever read them:
--   • the only preferences UI (features/users/user-preferences-tab.tsx) submits
--     language, timezone and date_format only;
--   • the theme/accent system is client-side (themes.css + next-themes);
--   • reduced motion comes from the OS via <MotionConfig reducedMotion="user">,
--     not from this table.
-- Removed from the schema, the update DTO, the service write path and the
-- frontend type in the same change, so no caller is left pointing at them.
-- =============================================================================

ALTER TABLE "user_preferences" DROP COLUMN IF EXISTS "accent_color";
--> statement-breakpoint
ALTER TABLE "user_preferences" DROP COLUMN IF EXISTS "density";
--> statement-breakpoint
ALTER TABLE "user_preferences" DROP COLUMN IF EXISTS "font_size";
--> statement-breakpoint
ALTER TABLE "user_preferences" DROP COLUMN IF EXISTS "reduced_motion";
--> statement-breakpoint
ALTER TABLE "user_preferences" DROP COLUMN IF EXISTS "high_contrast";
