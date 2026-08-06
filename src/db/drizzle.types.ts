import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;

/** The transaction handle Drizzle hands to `db.transaction`. */
export type TenantTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
