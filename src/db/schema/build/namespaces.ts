import { pgSchema } from "drizzle-orm/pg-core";

export const build = pgSchema("build");

export const buildEvents = pgSchema("build_events");
