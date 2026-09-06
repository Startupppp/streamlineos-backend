import { Injectable, Logger } from "@nestjs/common";
import postgres from "postgres";
import { normalizeDatabaseUrl } from "../../db/pool.config";
import type { RetainedTable } from "./notification-retention-policy";

const NEON_HOST_PATTERN = /\.neon\.tech/i;
const LOCK_TIMEOUT_PLAIN = "'1s'";
const LOCK_TIMEOUT_CONCURRENT = "'5s'";

function usernameFromUrl(url: string): string {
  try { return new URL(url).username; } catch { return ""; }
}

function errorCode(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const record: Record<string, unknown> = { ...err };
  return typeof record["code"] === "string" ? record["code"] : "";
}

function isLockTimeout(err: unknown): boolean {
  const code = errorCode(err);
  const msg = err instanceof Error ? err.message : String(err);
  return code === "55P03" || msg.includes("lock_timeout") || msg.includes("does not exist");
}

@Injectable()
export class PartitionMaintenanceService {
  private readonly logger = new Logger(PartitionMaintenanceService.name);

  async sweepParent(
    parent: RetainedTable,
    partitions: string[],
  ): Promise<{ detached: number; dropped: number }> {
    if (partitions.length === 0) return { detached: 0, dropped: 0 };

    const namePattern = new RegExp(`^${parent}_y\\d{4}_m\\d{2}$`);
    for (const p of partitions) {
      if (!namePattern.test(p)) {
        throw new Error(`RETENTION_DETACH: invalid partition name "${p}"`);
      }
    }

    const ownerUrl = process.env["DATABASE_URL"];
    const appUrl = process.env["APP_DATABASE_URL"];

    if (!ownerUrl) {
      this.logger.warn(
        "RETENTION_DETACH: no owner connection configured — set DATABASE_URL to the owner role",
      );
      return { detached: 0, dropped: 0 };
    }

    if (appUrl && usernameFromUrl(ownerUrl) === usernameFromUrl(appUrl)) {
      this.logger.warn(
        "RETENTION_DETACH: no owner connection configured — set DATABASE_URL to the owner role",
      );
      return { detached: 0, dropped: 0 };
    }

    const connectionString = normalizeDatabaseUrl(ownerUrl);
    const client = postgres(connectionString, {
      max: 1,
      prepare: false,
      ...(NEON_HOST_PATTERN.test(connectionString) ? { ssl: "require" as const } : {}),
    });

    let detached = 0;
    let dropped = 0;

    try {
      const modeRows = await client`
        SELECT EXISTS (
          SELECT 1 FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = ${parent}::regclass
          AND c.relpartbound IS NOT NULL
          AND pg_get_expr(c.relpartbound, c.oid) = 'DEFAULT'
        ) AS has_default
      `;
      const hasDefaultPartition = modeRows[0]?.has_default === true;

      const [oldest] = partitions;
      if (hasDefaultPartition && oldest !== undefined) {
        // Plain DETACH queues every new reader behind its ACCESS EXCLUSIVE wait, so one partition per sweep under a 1 s timeout.
        this.logger.log(
          `RETENTION_DETACH: ${parent} detach-mode=plain, 1 of ${partitions.length} expired partitions attempted this sweep`,
        );
        await client.unsafe(`SET lock_timeout = ${LOCK_TIMEOUT_PLAIN}`);
        const { detached: d, dropped: dr } = await this.detachOne(client, parent, oldest, false);
        detached = d;
        dropped = dr;
      } else {
        this.logger.log(`RETENTION_DETACH: ${parent} detach-mode=concurrent`);
        await client.unsafe(`SET lock_timeout = ${LOCK_TIMEOUT_CONCURRENT}`);
        for (const partition of partitions) {
          const { detached: d, dropped: dr } = await this.detachOne(
            client,
            parent,
            partition,
            true,
          );
          detached += d;
          dropped += dr;
        }
      }

      return { detached, dropped };
    } finally {
      await client.end();
    }
  }

  private async detachOne(
    client: ReturnType<typeof postgres>,
    parent: string,
    partition: string,
    useConcurrently: boolean,
  ): Promise<{ detached: number; dropped: number }> {
    const probe = await client`SELECT to_regclass(${partition}) IS NOT NULL AS present`;
    if (probe[0]?.present !== true) return { detached: 0, dropped: 0 };

    try {
      if (useConcurrently) {
        await client.unsafe(
          `ALTER TABLE ${parent} DETACH PARTITION ${partition} CONCURRENTLY`,
        );
      } else {
        await client.unsafe(`ALTER TABLE ${parent} DETACH PARTITION ${partition}`);
      }
    } catch (err) {
      if (isLockTimeout(err)) {
        this.logger.debug(
          `RETENTION_DETACH: ${partition} skipped — ${err instanceof Error ? err.message : String(err)}`,
        );
      } else {
        this.logger.warn(
          `RETENTION_DETACH: detach of ${partition} failed — ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return { detached: 0, dropped: 0 };
    }

    try {
      await client.unsafe(`DROP TABLE IF EXISTS ${partition}`);
      this.logger.log(`RETENTION_DETACH: dropped partition ${partition}`);
      return { detached: 1, dropped: 1 };
    } catch (err) {
      this.logger.warn(
        `RETENTION_DETACH: detached ${partition} but drop failed — ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return { detached: 1, dropped: 0 };
    }
  }
}
