import { SQL, StringChunk, getTableName, is } from "drizzle-orm";
import { signBulkSendRows } from "src/db/schema";
import type { Db } from "src/db/drizzle.types";
import { RateLimitService } from "src/common/ratelimit/rate-limit.service";
import { SignPublicController } from "src/modules/e-sign/sign-public.controller";
import { SignPublicService } from "src/modules/e-sign/sign-public.service";
import { SignBulkSendController } from "src/modules/e-sign/sign-bulk-send.controller";
import { SignBulkSendService } from "src/modules/e-sign/sign-bulk-send.service";
import { SignEnvelopeSweepsService } from "src/modules/e-sign/sign-envelope-sweeps.service";
import type { StorageService } from "src/modules/storage/storage.service";
import type { Observation } from "../matrix.types";
import { ORG_A, type Standing } from "../standings";
import { boundValues, standIn, type Row, type WorldDb } from "../world-db";
import { evaluate, propertyOf } from "../world-db-sql";
import { sendHttp } from "./http-adapter";
import { signDb } from "./sign-adapter";

export const tokenHash = (token: string): string => `h:${token}`;

const minted: Array<{ readonly orgId: string; readonly key: string }> = [];
const outcomes: string[] = [];

const recordingAudit = standIn({ record: async () => undefined });

export const rateLimitChecks: Array<readonly [string, string]> = [];

export const rateLimiter = standIn<RateLimitService>({
  check: async (tier: string, identifier: string) => {
    rateLimitChecks.push([tier, identifier]);
    return { allowed: true, retryAfterSecs: 0 };
  },
});

function publicService(world: WorldDb): SignPublicService {
  const storage = standIn<StorageService>({
    getFileUrl: async (orgId: string, key: string) => {
      minted.push({ orgId, key });
      return `https://signed.invalid/${key}`;
    },
  });
  return new SignPublicService(
    signDb(world),
    storage,
    recordingAudit,
    standIn({ hash: tokenHash }),
    standIn({ applyRecipientOutcome: async () => { outcomes.push("applyRecipientOutcome"); } }),
    standIn({}),
    standIn({}),
    standIn({}),
  );
}

export interface PublicExchange {
  readonly outcome: Observation["outcome"];
  readonly body: unknown;
  readonly minted: ReadonlyArray<{ readonly orgId: string; readonly key: string }>;
  readonly writes: ReadonlyArray<{ readonly table: string; readonly where: unknown }>;
}

export async function publicSigning(world: WorldDb, verb: "get" | "post", path: string, body?: object): Promise<PublicExchange> {
  minted.length = 0;
  outcomes.length = 0;
  const writeMark = world.writes.length;
  const exchange = await sendHttp(world, {
    controllers: [SignPublicController],
    services: [
      { provide: SignPublicService, useValue: publicService(world) },
      { provide: RateLimitService, useValue: rateLimiter },
    ],
    verb,
    path,
    body,
    standing: "outsider",
    orgId: ORG_A,
  });
  return {
    outcome: exchange.outcome,
    body: exchange.body,
    minted: [...minted],
    writes: world.writes.slice(writeMark).map((write) => ({ table: write.table, where: write.where })),
  };
}

function countText(node: unknown): string {
  if (!is(node, SQL)) return "";
  return node.queryChunks.map((chunk) => (is(chunk, StringChunk) ? chunk.value.join("") : "?")).join("");
}

function countingDb(world: WorldDb): Db {
  const base = signDb(world);
  const select = (fields?: unknown) => {
    const entries = fields !== null && typeof fields === "object" ? Object.entries(fields) : [];
    const only = entries.length === 1 ? entries[0] : undefined;
    if (only === undefined || countText(only[1]).trim().toLowerCase() !== "count(*)") return Reflect.apply(Reflect.get(world.db, "select"), world.db, [fields]);
    const alias = only[0];
    return {
      from: () => ({
        where: async (predicate: unknown): Promise<Row[]> => {
          world.reads.push({ table: getTableName(signBulkSendRows), where: predicate });
          const rows = (world.rows.get(signBulkSendRows) ?? []).filter(
            (row) => evaluate(predicate, (column) => row[propertyOf(column)]) === true,
          );
          return [{ [alias]: String(rows.length) }];
        },
      }),
    };
  };
  return standIn<Db>({ ...base, select });
}

export const BULK_ENTRY_SHIM = "count(*) over sign_bulk_send_rows evaluated by the sign token adapter";

export async function bulkSend(
  world: WorldDb,
  route: "read" | "cancel" | "error-report",
  standing: Standing,
  orgId: string,
  jobId: number,
): Promise<Observation> {
  const readMark = world.reads.length;
  const writeMark = world.writes.length;
  const service = new SignBulkSendService(countingDb(world), standIn({ record: async () => undefined }), standIn({}), standIn({}), standIn({}), standIn({}), standIn({}));
  const exchange = await sendHttp(world, {
    controllers: [SignBulkSendController],
    services: [{ provide: SignBulkSendService, useValue: service }],
    verb: route === "cancel" ? "post" : "get",
    path: route === "read" ? `/sign/bulk-send/jobs/${jobId}` : route === "cancel" ? `/sign/bulk-send/jobs/${jobId}/cancel` : `/sign/bulk-send/jobs/${jobId}/error-report`,
    permissionKey: "sign:bulk_send:run",
    standing,
    orgId,
    scopeOverrides: { "sign:bulk_send:run": "all" },
    wiring: "bulk",
  });
  const lookups = world.reads.slice(readMark).filter((read) => read.table === "sign_bulk_send_jobs");
  const bound = lookups.flatMap((read) => boundValues(read.where));
  const writes = world.writes.slice(writeMark).filter((write) => write.table === "sign_bulk_send_jobs");
  return {
    outcome: exchange.outcome,
    checks: {
      jobLookupBindsCallerOrgAndJob: lookups.length >= 1 && bound.includes(orgId) && bound.includes(jobId),
      writesOnlyWhenAllowed: route !== "cancel" || (exchange.outcome === "allow") === (writes.length === 1),
    },
  };
}

export const emitted: Array<{ readonly orgId: unknown; readonly id: unknown }> = [];

export function sweeps(world: WorldDb): SignEnvelopeSweepsService {
  return new SignEnvelopeSweepsService(
    world.db,
    standIn({ record: async () => undefined }),
    standIn({}),
    standIn({}),
    standIn({}),
    standIn({
      emitEnvelopeEvent: (envelope: { orgId?: unknown; id?: unknown }) => {
        emitted.push({ orgId: envelope.orgId, id: envelope.id });
      },
    }),
  );
}
