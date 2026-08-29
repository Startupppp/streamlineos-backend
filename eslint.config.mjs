import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    /**
     * `evals/` is linted on the same terms as `src/`, and was not before.
     *
     * It is first-class code — `tsconfig.json` includes it, jest's `roots`
     * cover it, and CI runs its acceptance gates on every pull request — but it
     * sat outside this glob, so it fell through to the recommended defaults
     * where `no-unused-vars` is an ERROR with no `argsIgnorePattern`. That is
     * the whole story behind the eight long-standing errors there: seven were
     * `_input` parameters on `runEval` callbacks, written in the convention this
     * block establishes, against a config that had never been told about it.
     * They were invisible because the `lint` script did not glob the directory
     * either, so nothing ever reported them.
     */
    files: ["src/**/*.ts", "test/**/*.ts", "evals/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-expressions": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-empty": "warn",
      "no-regex-spaces": "warn",
      "no-useless-assignment": "warn",
      "no-useless-escape": "warn",
      "prefer-const": "warn",
    },
  },
  {
    files: ["src/modules/**/*.ts", "src/common/**/*.ts"],
    ignores: [
      "**/*.spec.ts",
      "**/*.e2e-spec.ts",
      "**/__tests__/**",
      "**/*.test.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            'MemberExpression[object.object.name="process"][object.property.name="env"][computed=false][property.name!="NODE_ENV"]',
          message:
            "Read configuration through the injected APP_CONFIG token, not process.env. NODE_ENV is the one exception - it is read before the injector exists.",
        },
        {
          selector:
            'MemberExpression[object.name="process"][property.name="env"]:not([parent.type="MemberExpression"])',
          message:
            "Passing process.env around as a value is the same read one indirection later - it hid three unvalidated variables behind `env = process.env` defaults. Inject APP_CONFIG.",
        },
        {
          selector:
            'MemberExpression[object.object.name="process"][object.property.name="env"][computed=true][property.value!="NODE_ENV"]',
          message:
            "Read configuration through the injected APP_CONFIG token, not process.env[...]. The bracket form is the same read and is not an escape hatch.",
        },
      ],
    },
  },
  {
    // Ratchet, not an exemption: these predate the config seam and shrink as they migrate.
    files: [
      "src/common/audit/internal-audit.controller.ts",
      "src/common/auth/jwt-auth.guard.ts",
      "src/common/cache/cache.module.ts",
      "src/common/portal-auth/portal-jwt-auth.guard.ts",
      "src/common/security/secret-encryption.util.ts",
      // Region topology reads dynamic REGION_<KEY>_* variables parsed at runtime,
      // so the key set cannot exist in a fixed AppConfig schema. Both
      // resolveRegionTopology and resolvePoolConfig validate their env bag and throw.
      "src/common/region/region.module.ts",
      "src/common/tenant/with-tenant.ts",
      "src/modules/ai/confirmation/ai-confirmation.service.ts",
      "src/modules/ai/core/providers/embeddings.service.ts",
      "src/modules/ai/core/providers/llm-provider.config.ts",
      "src/modules/ai/core/providers/llm-retry.ts",
      "src/modules/ai/core/services/chat-assistant-model.ts",
      "src/modules/auth/auth.controller.ts",
      "src/modules/billing/core/plan-entitlements.constants.ts",
      "src/modules/billing/payments/payments.controller.ts",
      "src/modules/crm/consent/unsubscribe-token.util.ts",
      "src/modules/cron/cron-secret.ts",
      "src/modules/email/app-url.ts",
      "src/modules/email/branding.ts",
      "src/modules/email/email-webhook.service.ts",
      "src/modules/email/email.constants.ts",
      "src/modules/email/email.provider.ts",
      "src/modules/email/unsubscribe-token.ts",
      "src/modules/feedbucket/feedbucket-ai.service.ts",
      "src/modules/hr/import/hr-export-jobs.service.ts",
      "src/modules/hr/interviews/hr-interview-scheduling.service.ts",
      "src/modules/hr/onboarding/core/crypto.helpers.ts",
      "src/modules/payroll/hr-payroll/lib/encryption.ts",
      "src/modules/hr/recruitment/recruitment-jobs.service.ts",
      "src/modules/mfa/mfa.service.ts",
      "src/modules/organization/setup/org-setup.service.ts",
      "src/modules/portal/auth/portal-token.service.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
  /**
   * The authoring-time half of ticket 08.
   *
   * `legacy-reader-ratchet.spec.ts` already fails the build if a new file reads
   * `leads`, `clients` or `contacts` — but it fails in CI, after the code is
   * written and often after it is reviewed. This says the same thing in the
   * editor, which is where somebody can still cheaply choose the Party seam
   * instead.
   *
   * Both, not either: a lint rule can be disabled inline or the file excluded,
   * and the test is what notices when it is. Neither alone is a guard.
   *
   * The exemption list below is generated from the ratchet's own `KNOWN_READERS`,
   * so the two cannot drift into disagreeing about what is allowed. When ticket
   * 08 drops the tables, both lists go to zero and both of these disappear.
   */
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/db/schema/**",
      "src/modules/accounting/core/accounting-payables-query.service.ts",
      "src/modules/accounting/core/accounting-receivables.service.ts",
      "src/modules/finance/ap/bills-due-check.service.ts",
      "src/modules/finance/ap/payment-runs.service.ts",
      "src/modules/finance/ap/recurring-bills.service.ts",
      "src/modules/finance/ap/vendor-credits.service.ts",
      "src/modules/finance/ap/vendor-payments-list.service.ts",
      "src/modules/finance/ar/ar-payments.service.ts",
      "src/modules/finance/ar/statements.service.ts",
      "src/modules/finance/banking/matching.service.ts",
      "src/modules/finance/reports/insights-finders.service.ts",
      "src/modules/finance/reports/statement-reports.service.ts",
      "src/modules/finance/tax/tax-reports.service.ts",
      "src/modules/party/party-divergence.service.ts",
      "src/modules/party/party-legacy-backfill.db.spec.ts",
      "src/modules/party/party-legacy-clients.ts",
      "src/modules/party/party-legacy-contacts.ts",
      "src/modules/party/party-legacy-employer.ts",
      "src/modules/party/party-legacy-leads.ts",
      "src/modules/party/party-legacy-mirror.spec.ts",
      "src/modules/party/party-legacy-orgs.ts",
      "src/modules/party/party-legacy-seam.ts",
      "src/modules/party/party-legacy-writer.db.spec.ts",
      "src/modules/party/party-legacy-writer.spec.ts",
      "src/modules/party/party-legacy-writer.ts",
      "src/modules/party/party-mirror-fields.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/db/schema", "**/db/schema/crm/**"],
              importNames: ["leads", "clients", "contacts", "crmOrganizations"],
              message:
                "The legacy identity tables are being retired. Resolve through the Party seam instead — see src/modules/party/party-legacy-seam.ts.",
            },
          ],
        },
      ],
    },
  },
);
