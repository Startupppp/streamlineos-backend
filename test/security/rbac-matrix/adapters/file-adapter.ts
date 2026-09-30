/**
 * File (signed URL) adapter for the RBAC verification matrix.
 *
 * Signed URL issuance is the file transport's authorization gate.  Two
 * properties are verified:
 *
 *  1. PERMISSION GATE (HTTP layer) — a caller missing `build:files:view`
 *     receives 403 from the PermissionGuard before the service is reached.
 *     A caller holding the permission passes the guard.
 *
 *  2. MODULE GATE (HTTP layer) — the FilesController carries
 *     `@RequireModule("build")`.  When the plan module is disabled the
 *     ModuleGuard returns 402 before any permission or ownership check.
 *
 *  3. CROSS-RESOURCE 404 (service layer) — `FilesService.getSignedUrl` calls
 *     `assertProjectAccess` which queries the project row with an org-id
 *     predicate.  A request for a project that does not belong to the caller's
 *     org produces a `NotFoundException`, satisfying BE-91: the 404 conceals
 *     existence rather than confirming it with a 403.
 *
 * The cross-resource probe is exercised at the service level with a mock DB
 * (same pattern as bola-build-project-binding-404.spec.ts) because the guard
 * chain only sees the permission key; the ownership check lives in the service.
 */

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "src/db/drizzle.module";
import type { AccessService } from "src/modules/access/access.service";
import type { AuditService } from "src/common/audit/audit.service";
import type { StorageService } from "src/modules/storage/storage.service";
import { FilesController } from "src/modules/build/files/files.controller";
import { FilesService } from "src/modules/build/files/files.service";
import { actorOf, ORG_A } from "../../../helpers/authz-deny-harness";
import {
  runHttpPermissionCell,
  runHttpModuleCell,
} from "./http-adapter";

export interface FilePermissionResult {
  readonly denyStatus: number;
  readonly allowStatus: number;
}

export interface FileModuleResult {
  readonly moduleDisabledStatus: number;
  readonly moduleEnabledStatus: number;
}

export interface FileCrossTenantResult {
  readonly crossTenantThrows: boolean;
  readonly exceptionIsNotFound: boolean;
  readonly exceptionIsNotForbidden: boolean;
  readonly sameTenantSucceeds: boolean;
}

/**
 * Permission gate: caller missing `build:files:view` receives 403.
 */
export async function runFilePermissionCell(
  projectId = 1,
): Promise<FilePermissionResult> {
  const result = await runHttpPermissionCell({
    controllers: [FilesController],
    verb: "get",
    path: `/build/${projectId}/files`,
    permissionKey: "build:files:view",
  });
  return { denyStatus: result.denyStatus, allowStatus: result.allowStatus };
}

/**
 * Module gate: plan module disabled → 402.
 */
export async function runFileModuleCell(
  projectId = 1,
): Promise<FileModuleResult> {
  const result = await runHttpModuleCell({
    controllers: [FilesController],
    verb: "get",
    path: `/build/${projectId}/files`,
    permissionKey: "build:files:view",
  });
  return { moduleDisabledStatus: result.denyStatus, moduleEnabledStatus: result.allowStatus };
}

interface ProjectDbFixture {
  readonly db: Db;
}

/**
 * Returns a DB double whose `db.query.projects.findFirst` resolves with `row`.
 * Setting `row` to `undefined` models the cross-tenant miss: the project
 * belongs to a different org, so the org-bound lookup finds nothing.
 *
 * For the same-tenant positive case, `db.select().from().where().limit(1)`
 * returns a file row so `loadFile` resolves and `getFileUrl` is reached.
 */
function makeProjectDb(
  row: { managerMembershipId: number | null } | undefined,
): ProjectDbFixture {
  const fileRow = row !== undefined
    ? [{ id: 1, uploadedByMembershipId: 1, storageKey: `${ORG_A}/files/1.pdf` }]
    : [];

  const limitFn = jest.fn().mockResolvedValue(fileRow);
  const whereFn = jest.fn().mockReturnValue({ limit: limitFn });
  const innerJoinFn = jest.fn().mockReturnValue({ where: whereFn });
  const fromFn = jest.fn().mockReturnValue({
    innerJoin: innerJoinFn,
    where: whereFn,
  });
  const selectFn = jest.fn().mockReturnValue({ from: fromFn });

  const db = {
    query: {
      projects: {
        findFirst: jest.fn().mockResolvedValue(row),
      },
    },
    select: selectFn,
  } as unknown as Db;
  return { db };
}

function fakeAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>(["build:files:view", "build:manage"])),
    scopeFor: jest.fn().mockResolvedValue("all"),
  } as unknown as AccessService;
}

function fakeStorage(): StorageService {
  return {
    getFileUrl: jest.fn().mockResolvedValue("https://example.com/signed?token=abc"),
  } as unknown as StorageService;
}

function fakeAudit(): AuditService {
  return { log: jest.fn() } as unknown as AuditService;
}

/**
 * Cross-resource ownership: a project id that does not belong to the caller's
 * org produces NotFoundException (404), not ForbiddenException (403).
 * The positive control verifies a same-org project id is served normally.
 */
export async function runFileCrossTenantCell(
  ownOrgId = ORG_A,
): Promise<FileCrossTenantResult> {
  const callerOwner = actorOf({ orgId: ownOrgId, isOrgOwner: true });

  const { db: crossDb } = makeProjectDb(undefined);
  const svcCross = new FilesService(crossDb, fakeAccess(), fakeAudit(), fakeStorage());

  let crossTenantThrows = false;
  let exceptionIsNotFound = false;
  let exceptionIsNotForbidden = false;

  const crossErr = await svcCross
    .getSignedUrl(callerOwner, 9999, 1)
    .catch((e: unknown) => e);

  if (crossErr instanceof Error) {
    crossTenantThrows = true;
    exceptionIsNotFound = crossErr instanceof NotFoundException;
    exceptionIsNotForbidden = !(crossErr instanceof ForbiddenException);
  }

  const { db: sameDb } = makeProjectDb({ managerMembershipId: null });
  const svcSame = new FilesService(sameDb, fakeAccess(), fakeAudit(), fakeStorage());

  let sameTenantSucceeds = false;
  try {
    await svcSame.getSignedUrl(callerOwner, 1, 1);
    sameTenantSucceeds = true;
  } catch {
    sameTenantSucceeds = false;
  }

  return {
    crossTenantThrows,
    exceptionIsNotFound,
    exceptionIsNotForbidden,
    sameTenantSucceeds,
  };
}
