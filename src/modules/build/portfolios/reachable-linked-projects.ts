import { sql, type SQL } from "drizzle-orm";
import { projects } from "../../../db/schema";

export function reachableProjectIdsSql(orgId: string, reach: SQL): SQL {
  return sql`(SELECT ${projects.id} FROM ${projects} WHERE ${projects.orgId} = ${orgId} AND ${projects.deletedAt} IS NULL AND ${reach})`;
}
