import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { assertPathOrgIsCallerOrg } from "src/modules/organization/core/assert-path-org";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKEND_ROOT } from "./route-surface";

/**
 * `POST /organization/:orgId/purge/schedule` and `DELETE /organization/:orgId/purge` — found by the
 * live cross-tenant sweep.
 *
 * Both declared `:orgId`, ignored it, and acted on `u.orgId`. The probe measured control 200 and
 * cross-tenant 200; nothing crossed, because the handler had already substituted the caller's own
 * organisation. That substitution is what makes it dangerous in the other direction — the caller
 * believes they addressed the organisation in the URL and the server purges a different one — and
 * it leaves the box's required 404 absent on a route that addresses an object.
 */

const CALLER_ORG = "org-b-caller";
const OTHER_ORG = "org-a-victim";

describe("BOLA probe — the organisation purge routes' path parameter", () => {
  it("CROSS-TENANT-MISS: another organisation's id in the path is refused", () => {
    expect(() => assertPathOrgIsCallerOrg(OTHER_ORG, CALLER_ORG)).toThrow(NotFoundException);
  });

  it("EXISTENCE-ORACLE-GUARD: the refusal is NotFound, never Forbidden", () => {
    const thrown = ((): unknown => {
      try {
        assertPathOrgIsCallerOrg(OTHER_ORG, CALLER_ORG);
        return null;
      } catch (error: unknown) {
        return error;
      }
    })();
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
  });

  it("SAME-TENANT: the caller's own organisation still passes, so this is not a blanket denial", () => {
    expect(() => assertPathOrgIsCallerOrg(CALLER_ORG, CALLER_ORG)).not.toThrow();
  });

  /**
   * The guard has to be CALLED, not merely exported. A helper nobody invokes is the shape that
   * lets a fix land inert, which this release has already seen more than once.
   */
  it("WIRED: both purge handlers call the guard", () => {
    const source = readFileSync(
      join(BACKEND_ROOT, "src/modules/organization/core/organization.controller.ts"),
      "utf8",
    );
    const schedule = source.slice(source.indexOf('@Post(":orgId/purge/schedule")'));
    const scheduleBody = schedule.slice(0, schedule.indexOf('@Delete(":orgId/purge")'));
    const cancel = source.slice(source.indexOf('@Delete(":orgId/purge")'));
    const cancelBody = cancel.slice(0, cancel.indexOf("@Post(\"legal-holds\")"));
    expect(scheduleBody).toContain("assertPathOrgIsCallerOrg(orgId, u.orgId)");
    expect(cancelBody).toContain("assertPathOrgIsCallerOrg(orgId, u.orgId)");
  });
});
