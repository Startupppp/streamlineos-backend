-- Phase 3, tickets 17 and 18. The data subject request surface becomes reachable:
-- `POST /compliance/subject-requests` and `GET /compliance/subject-requests`, gated on
-- `compliance:subject-requests:execute` and `:view`. This catalogues both keys and backfills
-- them onto organisations that already exist.
--
-- `module_key` is 'compliance', which is not a module anybody enables. There is no registry
-- entry for it, so `isCoreModuleKey` answers true and the keys are unconditionally
-- module-available -- the same treatment `settings:` and `ownership:` get, and the reason
-- `administering-module-exists.spec.ts` now carries "compliance" in NON_MODULE_NAMESPACES.
--
-- ORG_ADMIN, and nothing else. Role templates only grant on role CREATION, so a new key never
-- reaches an organisation that already exists; ORG_ADMIN is what `systemRoleSpecs` mints for
-- every organisation, and `ROLE_DEFAULT_PERMISSIONS.ORG_ADMIN` is ALL_PERMISSION_NAMES, so an
-- organisation created after this ships gets both keys at seed time. This closes the gap for
-- the ones created before.
--
-- No COMPLIANCE_MODULE_OWNER/_ADMIN, deliberately: the seeder mints those from the module
-- registry and compliance has no entry there, so naming them would match zero rows and grant
-- to nobody -- the exact failure `backfill-slugs-exist.spec.ts` exists for. No 'OWNER' either,
-- and for a different reason: there is no OWNER role row to grant to. `access.service.ts:655`
-- returns scope 'all' for `isOrgOwner` before any grant is consulted, so an organisation owner
-- already holds every catalogued key without one.
--
-- Which is exactly why these keys are NOT the gate on a cross-tenant erasure. Running a subject
-- request additionally requires being named in COMPLIANCE_SUBJECT_REQUEST_OPERATORS, which
-- fails closed when unset. Granting the permission broadly here is safe only because of that;
-- see `modules/compliance/subject-requests/subject-request-operators.ts`.
SET lock_timeout = '5s';
--> statement-breakpoint
INSERT INTO "permissions" ("name", "resource", "action", "description", "module_key")
VALUES
  ('compliance:subject-requests:view', 'compliance:subject-requests', 'view',
   'Read the record of data subject requests: which regions were visited, what each did, and whether the request may be reported as complete',
   'compliance'),
  ('compliance:subject-requests:execute', 'compliance:subject-requests', 'execute',
   'Run a data subject erasure or export across every region. Also requires being named as a subject request operator for this deployment',
   'compliance')
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "role_permission_grants" ("org_id", "role_id", "permission_key", "scope")
SELECT r."org_id", r."id", k."name", 'all'
FROM "roles" r
CROSS JOIN (VALUES
  ('compliance:subject-requests:view'),
  ('compliance:subject-requests:execute')
) AS k("name")
WHERE r."is_system" = true
  AND r."slug" = 'ORG_ADMIN'
  AND EXISTS (SELECT 1 FROM "permissions" p WHERE p."name" = k."name")
ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Bump so cached permission resolutions are invalidated across every node at once; a role that
-- gained a key and a cache that has not heard about it is a 403 nobody can reproduce.
INSERT INTO "access_versions" ("org_id", "permissions_version", "updated_at")
SELECT DISTINCT r."org_id", 2, now()
FROM "roles" r
WHERE r."is_system" = true
  AND r."slug" = 'ORG_ADMIN'
ON CONFLICT ("org_id") DO UPDATE
SET "permissions_version" = "access_versions"."permissions_version" + 1,
    "updated_at" = now();
