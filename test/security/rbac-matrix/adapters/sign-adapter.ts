import type { Type } from "@nestjs/common";
import { Table, asc, desc, getTableColumns, getTableName, is } from "drizzle-orm";
import * as schema from "src/db/schema";
import type { Db } from "src/db/drizzle.types";
import type { DataScope } from "src/modules/access/access.types";
import { SignFieldsController } from "src/modules/e-sign/sign-fields.controller";
import { SignFieldsService } from "src/modules/e-sign/sign-fields.service";
import { SignRecipientsController } from "src/modules/e-sign/sign-recipients.controller";
import { SignRecipientsService } from "src/modules/e-sign/sign-recipients.service";
import { SignDocumentsController } from "src/modules/e-sign/sign-documents.controller";
import { SignDocumentsService } from "src/modules/e-sign/sign-documents.service";
import { SignCertificatesController } from "src/modules/e-sign/sign-certificates.controller";
import { SignAuditService } from "src/modules/e-sign/sign-audit.service";
import { SignEnvelopesController } from "src/modules/e-sign/sign-envelopes.controller";
import { SignEnvelopesService } from "src/modules/e-sign/sign-envelopes.service";
import { SignEnvelopeAccessService } from "src/modules/e-sign/sign-envelope-access.service";
import { SignAiController } from "src/modules/e-sign/sign-ai.controller";
import { SignAiService } from "src/modules/e-sign/sign-ai.service";
import type { StorageService } from "src/modules/storage/storage.service";
import type { Observation } from "../matrix.types";
import { accessFor, type Standing } from "../standings";
import { UnsupportedQuery, standIn, type Row, type WorldDb } from "../world-db";
import { compareRows, evaluate, orderKey, propertyOf } from "../world-db-sql";
import { sendHttp, type RealProvider } from "./http-adapter";

interface RelationalOptions {
  readonly where?: unknown;
  readonly orderBy?: unknown;
  readonly limit?: number;
  readonly columns?: Readonly<Record<string, boolean>>;
  readonly with?: unknown;
}

function tableOf(key: string): Table {
  const candidate: unknown = Reflect.get(schema, key);
  if (!is(candidate, Table)) throw new UnsupportedQuery(`relational table ${key}`);
  return candidate;
}

function lookupRow(table: Table, row: Row) {
  return (column: Parameters<typeof propertyOf>[0]): unknown => {
    if (column.table !== table) throw new UnsupportedQuery(`column ${column.name} outside ${getTableName(table)}`);
    const property = propertyOf(column);
    if (!(property in row)) throw new UnsupportedQuery(`fixture row of ${getTableName(table)} has no ${property} column the query reads`);
    return row[property];
  };
}

function relationalFind(world: WorldDb, key: string, options: RelationalOptions = {}): Row[] {
  const table = tableOf(key);
  if (typeof options.where === "function" || options.with !== undefined) throw new UnsupportedQuery(`relational where/with on ${key}`);
  world.reads.push({ table: getTableName(table), where: options.where });
  const matched = (world.rows.get(table) ?? []).filter((row) => evaluate(options.where, lookupRow(table, row)) === true);
  const order: unknown =
    typeof options.orderBy === "function" ? options.orderBy(getTableColumns(table), { asc, desc }) : options.orderBy;
  const keys = (order === undefined ? [] : Array.isArray(order) ? order : [order]).map(orderKey);
  const sorted = [...matched].sort((left, right) => {
    for (const item of keys) {
      const result = compareRows(lookupRow(table, left)(item.column), lookupRow(table, right)(item.column));
      if (result !== 0) return item.descending ? -result : result;
    }
    return 0;
  });
  const limited = sorted.slice(0, options.limit ?? Number.POSITIVE_INFINITY);
  const columns = options.columns;
  if (columns === undefined) return limited.map((row) => ({ ...row }));
  const included = Object.entries(columns).filter(([, wanted]) => wanted).map(([name]) => name);
  const excluded = new Set(Object.entries(columns).filter(([, wanted]) => !wanted).map(([name]) => name));
  return limited.map((row) =>
    included.length > 0
      ? Object.fromEntries(included.map((name) => [name, row[name]]))
      : Object.fromEntries(Object.entries(row).filter(([name]) => !excluded.has(name))),
  );
}

const SHIMMED = ["signFields", "signRecipients", "signDocuments", "signBulkSendRows"];

export function signDb(world: WorldDb): Db {
  const query = Object.fromEntries(
    Object.entries(world.db.query).map(([key, value]) =>
      SHIMMED.includes(key)
        ? [
            key,
            {
              findFirst: async (options?: RelationalOptions) => relationalFind(world, key, { ...options, limit: 1 })[0],
              findMany: async (options?: RelationalOptions) => relationalFind(world, key, options),
            },
          ]
        : [key, value],
    ),
  );
  return standIn<Db>({ ...world.db, query });
}

export const SIGN_ENTRY_SHIM = "relational orderBy callback and column exclusion evaluated by the sign adapter";

export interface SignActor {
  readonly standing: Standing;
  readonly orgId: string;
  readonly scopes: Readonly<Record<string, DataScope>>;
}

export const signed: Array<{ readonly orgId: string; readonly key: string }> = [];
export const recorded: Array<{ readonly method: string; readonly args: readonly unknown[] }> = [];
const streamed: string[] = [];
const invoked: string[] = [];

function recorder<T>(methods: readonly string[]): T {
  return standIn<T>(
    Object.fromEntries(
      methods.map((method) => [
        method,
        async (...args: unknown[]) => {
          recorded.push({ method, args });
          return { id: 1, success: true };
        },
      ]),
    ),
  );
}

const storage = standIn<StorageService>({
  isConfigured: () => true,
  getFileUrl: async (orgId: string, key: string) => {
    signed.push({ orgId, key });
    return `https://signed.invalid/${key}`;
  },
  getFileStream: async (_orgId: string, key: string) => {
    streamed.push(key);
    throw new Error("the matrix never extracts document text");
  },
});

function gate(world: WorldDb, scopes: SignActor["scopes"]): RealProvider {
  return { provide: SignEnvelopeAccessService, useValue: new SignEnvelopeAccessService(signDb(world), accessFor(world, scopes)) };
}

export type SignWiring = "lists" | "mutations";

function providers(world: WorldDb, controller: Type<unknown>, wiring: SignWiring, scopes: SignActor["scopes"]): RealProvider[] {
  const db = signDb(world);
  const audit = new SignAuditService(db, standIn({ lookup: async () => null }));
  if (controller === SignFieldsController)
    return [gate(world, scopes), { provide: SignFieldsService, useValue: wiring === "lists" ? new SignFieldsService(db, audit) : recorder<SignFieldsService>(["update", "remove"]) }];
  if (controller === SignRecipientsController)
    return [
      gate(world, scopes),
      { provide: SignRecipientsService, useValue: wiring === "lists" ? new SignRecipientsService(db, audit, standIn({}), standIn({})) : recorder<SignRecipientsService>(["update", "remove"]) },
    ];
  if (controller === SignDocumentsController)
    return [
      gate(world, scopes),
      { provide: SignDocumentsService, useValue: wiring === "lists" ? new SignDocumentsService(db, storage, standIn({}), standIn({}), audit) : recorder<SignDocumentsService>(["delete"]) },
    ];
  if (controller === SignCertificatesController) return [{ provide: SignAuditService, useValue: audit }];
  if (controller === SignAiController)
    return [{ provide: SignAiService, useValue: new SignAiService(db, storage, standIn({ invokeText: async () => { invoked.push("invokeText"); return { text: "" }; } })) }];
  return [gate(world, scopes), { provide: SignEnvelopesService, useValue: recorder<SignEnvelopesService>(["send", "voidEnvelope", "correct", "extendExpiration"]) }];
}

export interface SignRequest {
  readonly controller: Type<unknown>;
  readonly wiring: SignWiring;
  readonly verb: "get" | "post" | "patch" | "delete";
  readonly path: string;
  readonly body?: object;
  readonly permissionKey: string;
}

export interface SignExchange {
  readonly outcome: Observation["outcome"];
  readonly body: unknown;
  readonly asked: readonly string[];
  readonly reads: readonly string[];
  readonly recorded: ReadonlyArray<{ readonly method: string; readonly args: readonly unknown[] }>;
  readonly signed: ReadonlyArray<{ readonly orgId: string; readonly key: string }>;
  readonly streamed: readonly string[];
  readonly invoked: readonly string[];
}

export async function sendSign(world: WorldDb, actor: SignActor, req: SignRequest): Promise<SignExchange> {
  recorded.length = 0;
  signed.length = 0;
  streamed.length = 0;
  invoked.length = 0;
  const readMark = world.reads.length;
  const exchange = await sendHttp(world, {
    controllers: [req.controller],
    services: providers(world, req.controller, req.wiring, actor.scopes),
    verb: req.verb,
    path: req.path,
    body: req.body,
    permissionKey: req.permissionKey,
    standing: actor.standing,
    orgId: actor.orgId,
    scopeOverrides: actor.scopes,
    wiring: `${req.wiring}:${JSON.stringify(actor.scopes)}`,
  });
  return {
    outcome: exchange.outcome,
    body: exchange.body,
    asked: exchange.asked,
    reads: world.reads.slice(readMark).map((read) => read.table),
    recorded: [...recorded],
    signed: [...signed],
    streamed: [...streamed],
    invoked: [...invoked],
  };
}
