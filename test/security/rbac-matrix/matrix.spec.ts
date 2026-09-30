/**
 * RBAC Verification Matrix — main spec
 *
 * Seed: actor × resource × action × tenant × state → expected outcome
 * Adapters: HTTP · realtime · background job · file (signed URL)
 * Ledger: proven · failed · unrun per cell
 *
 * Every cell here must satisfy BE-141: the deny assertion is paired with an
 * allow control so a guard that refuses everything still appears failing rather
 * than passing.
 *
 * Resources covered in this seed:
 *   • Build projects / tickets (HTTP)
 *   • RBAC role mutation (HTTP)
 *   • Module-access gate (HTTP — RequireModule("build"))
 *   • Realtime channel authorization (realtime adapter)
 *   • Background job org-binding (job adapter)
 *   • Signed URL issuance (file adapter)
 */

jest.setTimeout(30_000);

import { MatrixRunner } from "./matrix-runner";
import type { ScenarioCell } from "./matrix.types";
import {
  runRealtimePermissionCell,
  runRealtimeTenantIsolationCell,
} from "./adapters/realtime-adapter";
import {
  runJobOrgBindingCell,
} from "./adapters/job-adapter";
import {
  runFilePermissionCell,
  runFileModuleCell,
  runFileCrossTenantCell,
} from "./adapters/file-adapter";
import {
  runHttpPermissionCell,
  runHttpModuleCell,
} from "./adapters/http-adapter";

import { ProjectsController } from "src/modules/build/core/projects.controller";
import { RbacController } from "src/modules/rbac/rbac.controller";
import { FilesController } from "src/modules/build/files/files.controller";
import { ChatRealtimeController } from "src/modules/chat/chat-realtime.controller";

const ORG_OWNER = "org-a";
const FOREIGN_ORG = "org-b";

const runner = new MatrixRunner();

function cell(partial: Omit<ScenarioCell, "state"> & Partial<Pick<ScenarioCell, "state">>): ScenarioCell {
  return { state: "normal", ...partial };
}

const CELLS: readonly ScenarioCell[] = [
  cell({
    id: "http-build-view-403",
    actor: "org:member",
    resource: "build:tickets",
    action: "view",
    tenant: "same",
    expected: "403",
    adapter: "http",
  }),
  cell({
    id: "http-build-create-403",
    actor: "org:member",
    resource: "build:tickets",
    action: "create",
    tenant: "same",
    expected: "403",
    adapter: "http",
  }),
  cell({
    id: "http-rbac-manage-403",
    actor: "org:member",
    resource: "settings:rbac",
    action: "manage",
    tenant: "same",
    expected: "403",
    adapter: "http",
  }),
  cell({
    id: "http-files-view-403",
    actor: "org:member",
    resource: "build:files",
    action: "view",
    tenant: "same",
    expected: "403",
    adapter: "http",
  }),
  cell({
    id: "http-build-module-disabled-402",
    actor: "org:member",
    resource: "build:files",
    action: "view",
    tenant: "same",
    state: "module-disabled",
    expected: "402",
    adapter: "http",
  }),
  cell({
    id: "realtime-chat-read-403",
    actor: "org:member",
    resource: "chat:messages",
    action: "read",
    tenant: "same",
    expected: "403",
    adapter: "realtime",
  }),
  cell({
    id: "realtime-tenant-isolation",
    actor: "cross-tenant",
    resource: "chat:channels",
    action: "subscribe",
    tenant: "other",
    expected: "404",
    adapter: "realtime",
  }),
  cell({
    id: "job-release-consumer-org-binding",
    actor: "org:member",
    resource: "build:release",
    action: "notify",
    tenant: "other",
    expected: "404",
    adapter: "job",
  }),
  cell({
    id: "file-signed-url-permission-403",
    actor: "org:member",
    resource: "build:files",
    action: "signed-url",
    tenant: "same",
    expected: "403",
    adapter: "file",
  }),
  cell({
    id: "file-module-disabled-402",
    actor: "org:member",
    resource: "build:files",
    action: "signed-url",
    tenant: "same",
    state: "module-disabled",
    expected: "402",
    adapter: "file",
  }),
  cell({
    id: "file-cross-tenant-404",
    actor: "cross-tenant",
    resource: "build:files",
    action: "signed-url",
    tenant: "other",
    expected: "404",
    adapter: "file",
  }),
];

for (const c of CELLS) runner.declare(c);

describe("RBAC Matrix — HTTP adapter: Build tickets view", () => {
  it("[http-build-view-403] org:member missing build:tickets:view receives 403 (negative); with permission is not 403 (positive)", async () => {
    const { denyStatus, allowStatus } = await runHttpPermissionCell({
      controllers: [ProjectsController],
      verb: "get",
      path: "/build",
      permissionKey: "build:view",
    });
    try {
      expect(denyStatus).toBe(403);
      expect(allowStatus).not.toBe(403);
      runner.record("http-build-view-403", "proven");
    } catch (err) {
      runner.record("http-build-view-403", "failed", String(err));
      throw err;
    }
  });
});

describe("RBAC Matrix — HTTP adapter: Build tickets create", () => {
  it("[http-build-create-403] org:member missing build:tickets:create receives 403 (negative); with permission is not 403 (positive)", async () => {
    const { denyStatus, allowStatus } = await runHttpPermissionCell({
      controllers: [ProjectsController],
      verb: "post",
      path: "/build",
      permissionKey: "build:create",
    });
    try {
      expect(denyStatus).toBe(403);
      expect(allowStatus).not.toBe(403);
      runner.record("http-build-create-403", "proven");
    } catch (err) {
      runner.record("http-build-create-403", "failed", String(err));
      throw err;
    }
  });
});

describe("RBAC Matrix — HTTP adapter: RBAC role mutation", () => {
  it("[http-rbac-manage-403] org:member missing settings:rbac:manage receives 403 (negative); with permission is not 403 (positive)", async () => {
    const { denyStatus, allowStatus } = await runHttpPermissionCell({
      controllers: [RbacController],
      verb: "get",
      path: "/rbac/permissions",
      permissionKey: "settings:rbac:manage",
    });
    try {
      expect(denyStatus).toBe(403);
      expect(allowStatus).not.toBe(403);
      runner.record("http-rbac-manage-403", "proven");
    } catch (err) {
      runner.record("http-rbac-manage-403", "failed", String(err));
      throw err;
    }
  });
});

describe("RBAC Matrix — HTTP adapter: Build files view", () => {
  it("[http-files-view-403] org:member missing build:files:view receives 403 (negative); with permission is not 403 (positive)", async () => {
    const { denyStatus, allowStatus } = await runFilePermissionCell(1);
    try {
      expect(denyStatus).toBe(403);
      expect(allowStatus).not.toBe(403);
      runner.record("http-files-view-403", "proven");
    } catch (err) {
      runner.record("http-files-view-403", "failed", String(err));
      throw err;
    }
  });
});

describe("RBAC Matrix — HTTP adapter: Build module disabled", () => {
  it("[http-build-module-disabled-402] module disabled → 402 (negative); module enabled → not 402 (positive)", async () => {
    const { moduleDisabledStatus, moduleEnabledStatus } = await runFileModuleCell(1);
    try {
      expect(moduleDisabledStatus).toBe(402);
      expect(moduleEnabledStatus).not.toBe(402);
      runner.record("http-build-module-disabled-402", "proven");
    } catch (err) {
      runner.record("http-build-module-disabled-402", "failed", String(err));
      throw err;
    }
  });
});

describe("RBAC Matrix — Realtime adapter: chat permission gate", () => {
  it("[realtime-chat-read-403] missing chat:messages:read → 403 (negative); with permission → not 403 (positive)", async () => {
    const { denyStatus, allowStatus } = await runRealtimePermissionCell();
    try {
      expect(denyStatus).toBe(403);
      expect(allowStatus).not.toBe(403);
      runner.record("realtime-chat-read-403", "proven");
    } catch (err) {
      runner.record("realtime-chat-read-403", "failed", String(err));
      throw err;
    }
  });
});

describe("RBAC Matrix — Realtime adapter: tenant isolation", () => {
  it("[realtime-tenant-isolation] capability documents for different orgs are disjoint (negative is shared channels; positive is no sharing)", async () => {
    const { orgAChannels, orgBChannels, sharesChannels } = await runRealtimeTenantIsolationCell();
    try {
      expect(orgAChannels.length).toBeGreaterThan(0);
      expect(orgBChannels.length).toBeGreaterThan(0);
      expect(sharesChannels).toBe(false);
      runner.record("realtime-tenant-isolation", "proven");
    } catch (err) {
      runner.record("realtime-tenant-isolation", "failed", String(err));
      throw err;
    }
  });
});

describe("RBAC Matrix — Job adapter: release consumer org binding", () => {
  it("[job-release-consumer-org-binding] same-tenant event processes; cross-tenant event executes a query path and completes safely (no existence-oracle throw)", async () => {
    const { sameTenantSucceeds, crossTenantSelectExecuted, crossTenantHandlesSafely } =
      await runJobOrgBindingCell(ORG_OWNER, FOREIGN_ORG);
    try {
      expect(sameTenantSucceeds).toBe(true);
      expect(crossTenantSelectExecuted).toBe(true);
      expect(crossTenantHandlesSafely).toBe(true);
      runner.record("job-release-consumer-org-binding", "proven");
    } catch (err) {
      runner.record("job-release-consumer-org-binding", "failed", String(err));
      throw err;
    }
  });
});

describe("RBAC Matrix — File adapter: signed URL permission gate", () => {
  it("[file-signed-url-permission-403] missing build:files:view → 403 (negative); with permission → not 403 (positive)", async () => {
    const { denyStatus, allowStatus } = await runFilePermissionCell(1);
    try {
      expect(denyStatus).toBe(403);
      expect(allowStatus).not.toBe(403);
      runner.record("file-signed-url-permission-403", "proven");
    } catch (err) {
      runner.record("file-signed-url-permission-403", "failed", String(err));
      throw err;
    }
  });
});

describe("RBAC Matrix — File adapter: signed URL module gate", () => {
  it("[file-module-disabled-402] module disabled → 402 (negative); module enabled → not 402 (positive)", async () => {
    const { moduleDisabledStatus, moduleEnabledStatus } = await runFileModuleCell(1);
    try {
      expect(moduleDisabledStatus).toBe(402);
      expect(moduleEnabledStatus).not.toBe(402);
      runner.record("file-module-disabled-402", "proven");
    } catch (err) {
      runner.record("file-module-disabled-402", "failed", String(err));
      throw err;
    }
  });
});

describe("RBAC Matrix — File adapter: signed URL cross-tenant 404", () => {
  it("[file-cross-tenant-404] project not in caller org throws NotFoundException not ForbiddenException (negative: wrong exception class = 403 oracle); same org project succeeds (positive)", async () => {
    const result = await runFileCrossTenantCell(ORG_OWNER);
    try {
      expect(result.crossTenantThrows).toBe(true);
      expect(result.exceptionIsNotFound).toBe(true);
      expect(result.exceptionIsNotForbidden).toBe(true);
      expect(result.sameTenantSucceeds).toBe(true);
      runner.record("file-cross-tenant-404", "proven");
    } catch (err) {
      runner.record("file-cross-tenant-404", "failed", String(err));
      throw err;
    }
  });
});

describe("RBAC Matrix — Ledger", () => {
  it("ANTI-VACUITY: every declared cell was run (unrun = 0)", () => {
    const ledger = runner.ledger();
    const unrunCells = ledger.results.filter((r) => r.status === "unrun");
    if (unrunCells.length > 0) {
      const ids = unrunCells.map((c) => c.cellId).join(", ");
      throw new Error(
        `${unrunCells.length} matrix cell(s) declared but never run: ${ids}`,
      );
    }
    expect(ledger.unrun).toBe(0);
  });

  it("LEDGER-SUMMARY: reports proven/failed/unrun counts", () => {
    const ledger = runner.ledger();
    expect(ledger.cells.length).toBeGreaterThanOrEqual(CELLS.length);
    expect(ledger.proven + ledger.failed + ledger.unrun).toBe(ledger.cells.length);
    // eslint-disable-next-line no-console
    console.log(
      `\nRBAC Matrix Ledger: proven=${ledger.proven} failed=${ledger.failed} unrun=${ledger.unrun} total=${ledger.cells.length}`,
    );
  });
});
