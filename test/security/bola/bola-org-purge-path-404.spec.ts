import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { assertPathOrgIsCallerOrg } from "src/modules/organization/core/assert-path-org";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKEND_ROOT } from "./route-surface";

const CORE_DIR = join(BACKEND_ROOT, "src/modules/organization/core");
const ROUTE_DECORATOR = /@(?:Get|Post|Patch|Put|Delete)\(/g;

// Locates the handler in whichever core controller declares it, so splitting a controller cannot blind this gate.
function handlerBody(decorator: string): string | null {
  for (const file of readdirSync(CORE_DIR).filter((f) => f.endsWith(".controller.ts"))) {
    const source = readFileSync(join(CORE_DIR, file), "utf8");
    const start = source.indexOf(decorator);
    if (start === -1) continue;
    ROUTE_DECORATOR.lastIndex = start + decorator.length;
    const next = ROUTE_DECORATOR.exec(source);
    return source.slice(start, next ? next.index : source.length);
  }
  return null;
}

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
    for (const decorator of ['@Post(":orgId/purge/schedule")', '@Delete(":orgId/purge")']) {
      const body = handlerBody(decorator);
      expect(body).not.toBeNull();
      expect(body).toContain("assertPathOrgIsCallerOrg(orgId, u.orgId)");
    }
  });

  it("ANTI-VACUITY: a route that no longer exists is reported, not silently skipped", () => {
    expect(handlerBody('@Post(":orgId/purge/no-such-route")')).toBeNull();
  });
});
