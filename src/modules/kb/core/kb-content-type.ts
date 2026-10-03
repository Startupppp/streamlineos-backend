import { kbPages } from "../../../db/schema";

export type KbPageContentType = NonNullable<
  (typeof kbPages.$inferInsert)["contentType"]
>;
