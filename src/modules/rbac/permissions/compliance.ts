import { definePermissions } from "./types";

/**
 * The compliance namespace.
 *
 * `compliance` is not a module: it has no entry in `module-registry.ts`, nobody
 * enables or is billed for it, and there is no `COMPLIANCE_MODULE_ADMIN` ladder
 * for the seeder to mint. It administers itself, the same way `settings:` and
 * `ownership:` do — which is why `administering-module-exists.spec.ts` carries
 * it in `NON_MODULE_NAMESPACES`.
 *
 * Neither key is scopable. A data subject request is not narrowable to "own"
 * records: the subject is not the caller, and the whole point of the surface is
 * that it reaches every organisation the person appears in.
 *
 * These keys are not the real gate and should not be read as one. Every
 * organisation owner is authorised for every catalogued key
 * (`access.service.ts:655` returns scope "all" for `isOrgOwner` before any
 * grant is consulted), so holding `compliance:subject-requests:execute` is the
 * default state of ten thousand tenant owners, not a distinction. What actually
 * decides who may run a request is the declared-operator list in
 * `modules/compliance/subject-requests/subject-request-operators.ts`, which
 * fails closed. The permission exists so an administrator can take the surface
 * AWAY from a role, which the operator list cannot express.
 */
export const COMPLIANCE_PERMISSIONS = definePermissions([
  {
    name: "compliance:subject-requests:view",
    resource: "compliance:subject-requests",
    action: "view",
    description:
      "Read the record of data subject requests: which regions were visited, what each did, and whether the request may be reported as complete",
  },
  {
    name: "compliance:subject-requests:execute",
    resource: "compliance:subject-requests",
    action: "execute",
    description:
      "Run a data subject erasure or export across every region. Also requires being named as a subject request operator for this deployment",
  },
]);
