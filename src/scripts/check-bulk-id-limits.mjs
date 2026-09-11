#!/usr/bin/env node
/**
 * Gate: every z.array(...) property whose name is `ids` or ends in `Ids`
 * inside src/**\/*.schemas.ts must have a .max() call in its chain.
 *
 * An unbounded ids-array is a denial-of-service and read-amplification
 * vector: one request can force an arbitrarily large IN (...) or an
 * arbitrarily large write transaction.
 *
 * Detection strategy
 * ------------------
 * Schema properties are often written across multiple lines, e.g.:
 *
 *   memberIds: z
 *     .array(z.string())
 *     .optional(),
 *
 * A single-line regex misses these. This script collapses all whitespace
 * (including newlines) to a single space before scanning, then uses a
 * depth-aware parser to extract each property value and checks for both
 * z.array() and .max() within that value.
 *
 * Excluded paths: src/modules/crm/** and src/modules/inventory/**
 *
 * --self-test   run built-in fixtures and exit; proves the scanner is not
 *               vacuous and that multi-line declarations are detected.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const SRC_ROOT = new URL("../", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

const EXCLUDED_MODULE_DIRS = new Set(["crm", "inventory"]);

/**
 * Explicitly allowlisted properties that must NOT be capped.
 * Each entry must carry a reason. The gate will not flag these.
 *
 * THE ONE THING AN ENTRY MAY SAY. The vector this gate exists for is stated in
 * the header: "one request can force an arbitrarily large IN (...) or an
 * arbitrarily large write transaction". That is a property of a REQUEST. An
 * entry is legitimate only when the property is provably not one — an outbox
 * payload, a provider's response shape, an internal column deserializer, or a
 * declared `@ResponseSchema`.
 *
 * A `@ResponseSchema` is not decoration here. `common/openapi/response-contract.interceptor.ts`
 * parses the handler's actual return value against it and THROWS
 * `ResponseContractViolation` under `NODE_ENV=test` (it logs at error elsewhere).
 * So a `.max(N)` on a response array does not bound any work an attacker can
 * cause — the rows are already read by the time the schema runs — and it turns a
 * legitimately larger result into a hard test failure and a production error log.
 * Capping there is a defect, not a fix. Where the same logical field is also
 * accepted on the wire, the cap belongs on the REQUEST schema, and the entries
 * below name that cap and its file where one exists.
 *
 * Every entry below was verified by locating the enclosing exported schema and
 * grepping for its decorator: 20 resolve to a `@ResponseSchema(...)` at the
 * named `file:line`, and one (`inputsSnapshotSchema`) has no HTTP boundary at all.
 *
 * `file` matches either the bare basename or any trailing path segment, so an
 * entry can be path-qualified. Three different files in this repo are named
 * `payroll.schemas.ts`; a basename-only entry would have silently allowlisted
 * the property in all three.
 */
const ALLOWLIST = [
  {
    file: "chat-fanout-outbox.ts",
    prop: "mentionedUserIds",
    reason:
      "outbox event payload, not an HTTP body. A cap here would silently drop mention recipients from a fan-out that was already accepted and committed.",
  },
  {
    file: "mail-normalizers.ts",
    prop: "labelIds",
    reason:
      "shape of a Gmail provider response, not a client request. Truncating a provider's label list would corrupt message metadata rather than limit attacker-controlled work.",
  },

  // ── response contracts ────────────────────────────────────────────────────
  {
    file: "modules/ai/core/dto/ai-projects-response.schemas.ts",
    prop: "labelIds",
    reason:
      "`suggestDraftFieldsResponseSchema`, declared at modules/ai/core/controllers/projects-ai.controller.ts:245. The array is the model's own list of suggested labels for a draft ticket; its length is a function of the org's label catalogue and the model's output, neither of which the caller sets. A cap would fail the response contract on a legitimate suggestion set.",
  },
  {
    file: "modules/build/core/dto/build-tickets-response.schemas.ts",
    prop: "ticketIds",
    reason:
      "`bulkUpdateResultSchema`, declared at modules/build/core/projects-tickets.controller.ts:161. It echoes the ids the server actually updated. The caller-supplied id list is bounded on the REQUEST schema; capping the echo would only make a successful bulk update fail to describe itself.",
  },
  {
    file: "modules/build/forms/dto/forms-response.schemas.ts",
    prop: "createdTicketIds",
    reason:
      "`submissionCreateResultSchema`, declared at modules/build/forms/submissions.controller.ts:55. The ids are tickets the server created from the form's configured actions — a server-side artefact of the submission, not an array the submitter sends.",
  },
  {
    file: "modules/data-quality/dto/data-quality-response.schemas.ts",
    prop: "findingIds",
    reason:
      "`assignSchema` (imported as `assignResponseSchema`), declared at modules/data-quality/data-quality.controller.ts:115. It reports `{ assigned, findingIds }` for a completed bulk assign. Distinct from the `assignSchema` in modules/leads/dto, which IS a request body — hence the path-qualified entry.",
  },
  {
    file: "modules/finance/planning/dto/planning-response.schemas.ts",
    prop: "scenarioIds",
    reason:
      "`scenarioCompareResponseSchema`, declared at modules/finance/planning/scenarios.controller.ts:103. The request side is already capped: `compareScenariosQuerySchema` in modules/finance/planning/dto/finance-planning.schemas.ts:67 is `.min(2).max(5)`. This field is the echo of that already-bounded selection.",
  },
  {
    file: "modules/hr/core/dto/core-response.schemas.ts",
    prop: "ids",
    reason:
      "`customFieldFilterIdsSchema`, declared at modules/hr/core/hr-custom-fields.controller.ts:193. The array is the row ids matching a custom-field predicate — a query RESULT sized by the org's data. Capping it would truncate the answer rather than the question.",
  },
  {
    file: "modules/hr/interviews/dto/interviews-response.schemas.ts",
    prop: "panelInterviewerIds",
    reason:
      "`scheduleInterviewWithPanelSchema`, declared at modules/hr/interviews/hr-interview-scheduling.controller.ts:68. It projects the panel the server stored on the created interview; the submitted panel is validated by the separate request schema.",
  },
  {
    file: "modules/hr/onboarding/core/dto/onboarding-response.schemas.ts",
    prop: "dependsOnTaskIds",
    reason:
      "`onboardingTaskSchema`, reached through `onboardingTaskListSchema`, declared at modules/hr/onboarding/core/hr-onboarding-admin.controller.ts:142 and modules/hr/onboarding/core/onboarding.controller.ts:397. It projects a stored dependency-graph column on the task row.",
  },
  {
    file: "modules/hr/performance/dto/engagement-extras-response.schemas.ts",
    prop: "ids",
    reason:
      "the local `campaignSchema`'s `audience.ids`, reached through `listCampaignsResponseSchema` / `createCampaignResponseSchema` / `updateCampaignResponseSchema`, declared at modules/hr/performance/engagement-extras.controller.ts:214, :221 and :233. It projects the stored audience column of an engagement campaign.",
  },
  {
    file: "modules/hr/recruitment/dto/recruitment-candidate-records-response.schemas.ts",
    prop: "participantIds",
    reason:
      "`calibrationSessionSchema`, declared at modules/hr/recruitment/recruitment-candidate-records.controller.ts:158, :170 and :183. The write side is already capped at `.max(30)` in modules/hr/recruitment/dto/candidate-records.schemas.ts; this is the read projection of that column.",
  },
  {
    file: "modules/hr/workflows/dto/workflow-response.schemas.ts",
    prop: "resolvedApproverUserIds",
    reason:
      "the local `simulateStepSchema`, reached through `workflowSimulateResponseSchema`, declared at modules/hr/workflows/hr-workflow-definitions.controller.ts:147. The ids are RESOLVED by the simulator from role and org-unit membership; their count is a property of the org chart, not of the request.",
  },
  {
    file: "modules/invoices/dto/invoice-response.schemas.ts",
    prop: "invoiceIds",
    reason:
      "`invoiceRunRecurringResponseSchema`, declared at modules/invoices/invoices-write.controller.ts:65. The ids are the invoices the recurring run generated; the run takes no id list from the caller.",
  },
  {
    file: "modules/invoices/dto/invoice-response.schemas.ts",
    prop: "failedIds",
    reason:
      "the failure half of the same `invoiceRunRecurringResponseSchema` at modules/invoices/invoices-write.controller.ts:65. Capping it would hide failures from the operator report.",
  },
  {
    file: "modules/kb/article-conversion/dto/kb-migration-response.schemas.ts",
    prop: "failedArticleIds",
    reason:
      "`kbMigrationRunSchema`, declared at modules/kb/article-conversion/kb-article-migration.controller.ts:33. It reports which articles a migration run failed to convert — capping it would silently shorten the failure list an operator has to act on.",
  },
  {
    file: "modules/notifications/dto/broadcasts-response.schemas.ts",
    prop: "roleIds",
    reason:
      "the local `audienceSchema` inside `broadcastRowSchema`, declared at modules/notifications/broadcasts.controller.ts:86, :99, :112 and :145. The write side already caps this exact field at `.max(50)` in modules/notifications/dto/broadcast.schemas.ts; this is the read projection of the stored audience.",
  },
  {
    file: "modules/notifications/dto/broadcasts-response.schemas.ts",
    prop: "departmentIds",
    reason:
      "same `broadcastRowSchema` audience projection; the write side caps it at `.max(200)` in modules/notifications/dto/broadcast.schemas.ts.",
  },
  {
    file: "modules/notifications/dto/broadcasts-response.schemas.ts",
    prop: "userIds",
    reason:
      "same `broadcastRowSchema` audience projection; the write side caps it at `.max(200)` in modules/notifications/dto/broadcast.schemas.ts.",
  },
  {
    file: "modules/support/core/dto/support-settings-response.schemas.ts",
    prop: "candidateAgentIds",
    reason:
      "`supportRoutingRuleRowSchema`, declared at modules/support/core/support-macros.controller.ts:167, :177 and :191. The write side already caps it at `.max(50)` in modules/support/core/dto/support-tickets.schemas.ts; this is the read projection of the stored JSONB column.",
  },
  {
    file: "modules/support/kb-gap/dto/support-kb-gap-response.schemas.ts",
    prop: "sampleTicketIds",
    reason:
      "`supportKnowledgeGapRowSchema`, reached through `gapListResponseSchema` and `dismissGapResponseSchema`, declared at modules/support/kb-gap/support-kb-gap.controller.ts:52 and :95. The stored column is already bounded at write time by `cluster.ticketIds.slice(0, 10)` in support-kb-gap-detection.service.ts; nothing on the wire sets it.",
  },
  {
    file: "modules/surveys/dto/survey-analytics-response.schemas.ts",
    prop: "choiceIds",
    reason:
      "the local `surveyAnswerRowSchema`, reached through `surveyResponseDetailSchema`, declared at modules/surveys/survey-analytics.controller.ts:82. The write side caps it at `.max(50)` in modules/surveys/dto/survey-live-session.schemas.ts and survey-public.schemas.ts; this is the read projection of the stored answer.",
  },

  // ── not an HTTP boundary at all ───────────────────────────────────────────
  {
    file: "modules/payroll/dto/payroll.schemas.ts",
    prop: "consumedReimbursementIds",
    reason:
      "`inputsSnapshotSchema` has no controller reference in either direction — its only consumer is `toInputsSnapshot()`, called from modules/payroll/runs/run-data-loader.service.ts:225 to deserialize the `inputs_snapshot` JSONB column of a payroll run entry. `matches()` returns null on a parse failure, so a cap would make a payroll run that consumed more than N reimbursements silently drop every consumed id and re-pay them. Path-qualified because two other files are also named payroll.schemas.ts.",
  },
];

/**
 * `file` is either a basename or a trailing path segment. Kept deliberately
 * anchored on a `/` boundary so `payroll.schemas.ts` cannot be satisfied by
 * `hr-payroll.schemas.ts`.
 */
function isAllowlisted(normalizedPath, propName) {
  return ALLOWLIST.some(
    (a) =>
      a.prop === propName &&
      (normalizedPath.endsWith(`/${a.file}`) || normalizedPath === a.file),
  );
}

// ─── file discovery ─────────────────────────────────────────────────────────

/**
 * Scan every TypeScript source, not only `*.schemas.ts`.
 *
 * Restricting discovery to one filename pattern made this gate blind to a
 * Zod body declared inline in a controller, which is exactly where an
 * unbounded ids-array is most likely to be written by accident. Specs are
 * excluded because a fixture is allowed to be deliberately unbounded.
 */
function isScannableSource(entry) {
  if (!entry.endsWith(".ts")) return false;
  if (entry.endsWith(".d.ts")) return false;
  if (entry.endsWith(".spec.ts") || entry.endsWith(".e2e-spec.ts")) return false;
  return true;
}

function isExcludedPath(fullPath) {
  const normalized = fullPath.replace(/\\/g, "/");
  for (const seg of EXCLUDED_MODULE_DIRS) {
    if (normalized.includes(`/modules/${seg}/`)) return true;
  }
  return false;
}

function collectSchemaFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...collectSchemaFiles(full));
    } else if (stat.isFile() && isScannableSource(entry)) {
      if (!isExcludedPath(full)) results.push(full);
    }
  }
  return results;
}

// ─── scanner ─────────────────────────────────────────────────────────────────

/**
 * Extract the property value starting at `start` in `flat`, stopping at the
 * first comma or closing bracket at depth 0. Depth is tracked across all
 * bracket types: ( [ {.
 */
function extractPropertyValue(flat, start) {
  let depth = 0;
  let i = start;
  while (i < flat.length) {
    const c = flat[i];
    if (c === "(" || c === "[" || c === "{") {
      depth++;
    } else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    } else if (c === "," && depth === 0) {
      break;
    } else if (c === ";" && depth === 0) {
      break;
    }
    i++;
  }
  return flat.slice(start, i);
}

/**
 * Scan `content` (the text of a schema file) for id-array properties that
 * lack a .max() call. Returns an array of violation objects.
 */
function scanContent(filePath, content) {
  // Collapse all whitespace (including newlines) to a single space so that
  // multi-line property declarations become one continuous string.
  const flat = content.replace(/\s+/g, " ");

  const violations = [];

  // Property names to detect:
  //   - exactly `ids`  (e.g. audience.ids)
  //   - anything ending in `Ids`  (e.g. memberIds, attendeeIds, leadIds)
  // We also allow an optional `?` before the `:` (optional properties in
  // discriminated unions / intersection types).
  const propRe = /\b((?:\w+I|i)ds)\s*\??\s*:/g;

  let m;
  while ((m = propRe.exec(flat)) !== null) {
    const propName = m[1];
    const valueStart = m.index + m[0].length;
    const value = extractPropertyValue(flat, valueStart);

    // Only flag properties whose value is a z.array(...) chain.
    if (!/z\s*\.array\s*\(/.test(value)) continue;

    // The chain must include .max( somewhere.
    if (/\.max\s*\(/.test(value)) continue;

    // Check allowlist.
    if (isAllowlisted(filePath.replace(/\\/g, "/"), propName)) continue;

    violations.push({
      file: filePath,
      prop: propName,
      snippet: value.trim().slice(0, 140),
    });
  }

  return violations;
}

// ─── self-test ───────────────────────────────────────────────────────────────

function runSelfTest() {
  console.log("Running self-test…");
  let allPassed = true;

  function assert(label, condition) {
    if (condition) {
      console.log(`  PASS  ${label}`);
    } else {
      console.error(`  FAIL  ${label}`);
      allPassed = false;
    }
  }

  // ── Fixture 1: multi-line unbounded declaration ──────────────────────────
  // This is the exact form that defeated a prior single-line regex gate.
  const multiLineUnbounded = `
export const createTestRunSchema = z.object({
  name: z.string().min(1).max(500),
  caseIds: z
    .array(z.number().int().positive())
    .optional(),
  suiteId: z.number().int().positive().optional(),
});
`;
  const multiLineFindings = scanContent("<fixture:multi-line>", multiLineUnbounded);
  assert(
    "multi-line unbounded declaration detected (not missed by whitespace collapse)",
    multiLineFindings.length === 1 && multiLineFindings[0].prop === "caseIds",
  );

  // ── Fixture 2: single-line unbounded declaration ─────────────────────────
  const singleLineUnbounded = `
export const bulkSchema = z.object({
  leadIds: z.array(z.number()).min(1),
  tagIds: z.array(z.string()),
});
`;
  const singleLineFindings = scanContent("<fixture:single-line>", singleLineUnbounded);
  assert(
    "single-line unbounded declaration detected (leadIds)",
    singleLineFindings.some((f) => f.prop === "leadIds"),
  );
  assert(
    "single-line unbounded declaration detected (tagIds)",
    singleLineFindings.some((f) => f.prop === "tagIds"),
  );

  // ── Fixture 3: bounded declarations must NOT be flagged ──────────────────
  // This proves the scanner is not vacuous: good declarations pass.
  const bounded = `
export const goodSchema = z.object({
  memberIds: z.array(z.string()).max(100).optional(),
  attendeeIds: z.array(z.string()).min(1).max(200),
  runEmployeeIds: z.array(z.number().int().positive()).max(100).optional(),
  choiceIds: z.array(z.number().int().positive()).max(50).optional(),
});
`;
  const boundedFindings = scanContent("<fixture:bounded>", bounded);
  assert(
    "bounded declarations are not flagged (scanner is not vacuous)",
    boundedFindings.length === 0,
  );

  // ── Fixture 4: non-array ids properties must not be flagged ─────────────
  const nonArray = `
export const filterSchema = z.object({
  assigneeId: z.string().optional(),
  projectIds: csvToIntArray,
});
`;
  const nonArrayFindings = scanContent("<fixture:non-array>", nonArray);
  assert(
    "non-z.array ids properties are not flagged (projectIds from csvToIntArray)",
    nonArrayFindings.length === 0,
  );

  // ── Fixture 5: multi-line bounded declaration must NOT be flagged ────────
  const multiLineBounded = `
export const otherSchema = z.object({
  memberIds: z
    .array(z.string())
    .max(100)
    .optional(),
});
`;
  const multiLineBoundedFindings = scanContent("<fixture:multi-line-bounded>", multiLineBounded);
  assert(
    "multi-line bounded declaration not flagged",
    multiLineBoundedFindings.length === 0,
  );

  // ── Fixture 6: inline body schema in a controller ────────────────────────
  // This is the shape the gate was previously blind to: discovery matched only
  // `*.schemas.ts`, so an unbounded array declared inline in a `@Validate({...})`
  // decorator was never scanned. The known-bad fixture is in that exact shape.
  const controllerInline = `
  @Post("huddles/:huddleId/invite")
  @Validate({ params: huddleIdParams, body: z.object({ userIds: z.array(z.string().min(1)).min(1) }) })
  invite() {}
`;
  const controllerFindings = scanContent("<fixture:controller-inline>", controllerInline);
  assert(
    "unbounded array inline in a controller @Validate body is detected",
    controllerFindings.length === 1 && controllerFindings[0].prop === "userIds",
  );

  assert(
    "a controller source file is scannable (discovery is not limited to *.schemas.ts)",
    isScannableSource("chat-huddles.controller.ts") &&
      isScannableSource("thing.schemas.ts") &&
      !isScannableSource("thing.spec.ts") &&
      !isScannableSource("thing.d.ts"),
  );

  // ── Fixture 7: the allowlist must not leak across same-named files ────────
  // Three files in this repo are named `payroll.schemas.ts`. Under the previous
  // basename-equality match, one path-blind entry exempted the property in all
  // three. A path-qualified entry must match only its own file, and must not be
  // satisfied by a longer basename that merely ends with it.
  assert(
    "a path-qualified allowlist entry matches its own file",
    isAllowlisted(
      "D:/x/src/modules/payroll/dto/payroll.schemas.ts",
      "consumedReimbursementIds",
    ),
  );
  assert(
    "a path-qualified allowlist entry does NOT match a same-named file elsewhere",
    !isAllowlisted(
      "D:/x/src/modules/timesheets/payroll/dto/payroll.schemas.ts",
      "consumedReimbursementIds",
    ) &&
      !isAllowlisted(
        "D:/x/src/modules/payroll/hr-payroll/dto/payroll.schemas.ts",
        "consumedReimbursementIds",
      ),
  );
  assert(
    "a bare-basename allowlist entry still matches (the two original entries)",
    isAllowlisted("D:/x/src/modules/chat/chat-fanout-outbox.ts", "mentionedUserIds") &&
      isAllowlisted("D:/x/src/modules/mail/mail-normalizers.ts", "labelIds"),
  );
  assert(
    "a bare-basename entry is anchored on a path separator, not a substring",
    !isAllowlisted("D:/x/src/modules/mail/gmail-mail-normalizers.ts", "labelIds"),
  );
  assert(
    "the allowlist is keyed on the property too — a different property in an allowlisted file is still flagged",
    !isAllowlisted(
      "D:/x/src/modules/notifications/dto/broadcasts-response.schemas.ts",
      "someOtherIds",
    ),
  );
  assert(
    "every allowlist entry carries a non-empty reason",
    ALLOWLIST.every((a) => typeof a.reason === "string" && a.reason.trim().length > 40),
  );

  if (!allPassed) {
    console.error("\nSelf-test FAILED.");
    process.exit(1);
  }
  console.log("\nAll self-tests passed.");
}

// ─── main ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const files = collectSchemaFiles(SRC_ROOT);

  if (files.length < 50) {
    console.error(
      `ERROR: only ${files.length} schema files found under ${SRC_ROOT} — ` +
        "scan appears incomplete; check SRC_ROOT.",
    );
    process.exit(1);
  }

  const allViolations = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    allViolations.push(...scanContent(file, content));
  }

  if (allViolations.length === 0) {
    console.log(
      `check:bulk-id-limits — scanned ${files.length} schema files; ` +
        "no unbounded id-array properties found.",
    );
    process.exit(0);
  }

  console.error(
    `\ncheck:bulk-id-limits — FOUND ${allViolations.length} UNBOUNDED ID-ARRAY PROPERT${allViolations.length === 1 ? "Y" : "IES"}:\n`,
  );
  for (const v of allViolations) {
    const rel = v.file.replace(/\\/g, "/").replace(SRC_ROOT.replace(/\\/g, "/"), "");
    console.error(`  ${rel}`);
    console.error(`    property : ${v.prop}`);
    console.error(`    value    : ${v.snippet}`);
    console.error();
  }
  console.error(
    "Add .max(<N>) to each array chain above. See backend/CLAUDE.md §4 " +
      "(resource consumption) for guidance on choosing N.",
  );
  process.exit(1);
}

main();
