import { BadRequestException, NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { PmWorkspacesService } from "./pm-workspaces.service";

const dialect = new PgDialect();

function renderParams(condition: unknown): unknown[] {
  return dialect.sqlToQuery(condition as SQL).params;
}

const audit = { log: jest.fn() } as never;
const ORG = "org-1";

function makeDb(row: { pmWorkspaceId: string; status: string } | null) {
  const limit = jest.fn().mockResolvedValue(row === null ? [] : [row]);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const db = { select: jest.fn().mockReturnValue({ from }) } as unknown as Db;
  return { db, where };
}

function serviceFor(db: Db) {
  return new PmWorkspacesService(db, audit);
}


describe("resolveWorkspaceIdForWrite", () => {
  it("falls back to the organization default when no workspace is requested", async () => {
    const { db } = makeDb({ pmWorkspaceId: "ws-default", status: "active" });
    const svc = serviceFor(db);
    jest
      .spyOn(svc, "resolveDefaultWorkspaceId")
      .mockResolvedValue("ws-default");

    await expect(svc.resolveWorkspaceIdForWrite(ORG, undefined)).resolves.toBe(
      "ws-default",
    );
  });

  it("honours an explicitly requested workspace that belongs to the organization", async () => {
    const { db } = makeDb({ pmWorkspaceId: "ws-2", status: "active" });

    await expect(
      serviceFor(db).resolveWorkspaceIdForWrite(ORG, "ws-2"),
    ).resolves.toBe("ws-2");
  });

  it("rejects a workspace id that does not resolve inside the caller's organization", async () => {
    const { db } = makeDb(null);

    await expect(
      serviceFor(db).resolveWorkspaceIdForWrite(ORG, "ws-other-tenant"),
    ).rejects.toThrow(NotFoundException);
  });

  it("scopes the workspace lookup by the caller's organization so another tenant's id cannot be written to", async () => {
    const { db, where } = makeDb({ pmWorkspaceId: "ws-2", status: "active" });

    await serviceFor(db).resolveWorkspaceIdForWrite(ORG, "ws-2");

    expect(where).toHaveBeenCalledTimes(1);
    expect(renderParams(where.mock.calls[0]?.[0])).toEqual(
      expect.arrayContaining([ORG, "ws-2"]),
    );
  });

  it("refuses to create records inside an archived workspace", async () => {
    const { db } = makeDb({ pmWorkspaceId: "ws-2", status: "archived" });

    await expect(
      serviceFor(db).resolveWorkspaceIdForWrite(ORG, "ws-2"),
    ).rejects.toThrow(BadRequestException);
  });
});
