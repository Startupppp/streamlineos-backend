import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  /**
   * The `.mjs` operational scripts run on Node, and nothing had ever told
   * ESLint so. Every `process`, `console` and `fetch` in them resolved to
   * `no-undef` — 3,730 errors across 235 files, none of them real. The reason
   * nobody noticed is that the `lint` script globs only `*.ts`, so the scripts
   * were never linted at all: the errors existed but were unreachable.
   *
   * Declared explicitly rather than via the `globals` package, which is not a
   * dependency here and is not worth adding for fourteen names. The list is
   * exactly what the tree references — measured, not guessed — so an unexpected
   * global still fails rather than being waved through by a blanket env.
   */
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        AbortSignal: "readonly",
        Blob: "readonly",
        Buffer: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        WebSocket: "readonly",
      },
    },
    rules: {
      // A few scripts import `process`/`URL` explicitly from `node:` modules,
      // which is the better habit, not a redeclaration. Without this the global
      // list above would punish them for it. Redeclarations within a file are
      // still errors.
      "no-redeclare": ["error", { builtinGlobals: false }],
    },
  },
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
    files: ["src/**/*.ts", "test/**/*.ts", "evals/**/*.ts", "**/*.mjs"],
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
    files: ["src/**/*.ts"],
    ignores: [
      "src/config/**",
      "src/scripts/**",
      "src/test/**",
      "src/main.ts",
      "src/db/seeds/**",
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
    /**
     * Reads that genuinely precede the injector, or that no schema can express.
     *
     * Separate from the ratchet below on purpose. The ratchet is a list that is
     * supposed to shrink; these are not migrations waiting to happen, and each
     * one carries the reason it cannot be an `APP_CONFIG` injection. If a
     * future change makes one of them injectable, it moves out — but it does
     * not belong in a queue of things we simply have not got to yet.
     */
    files: [
      // Default `= process.env` on the resolver that `admission.module.ts`'s
      // `useFactory` calls to build the AdmissionService provider itself.
      "src/common/admission/admission.config.ts",
      // A module-level `const`, evaluated at import — before any injector exists.
      "src/common/cell-resources/cell-id.ts",
      // `LogErrorReporter` is hand-constructed in `main.ts`, outside the
      // container, and must keep stamping the release when the container is
      // the thing that failed.
      "src/common/observability/release.ts",
      // The three reads are the @Module factories that build the region
      // providers, and `resolveRegionTopology` composes variable names at
      // runtime (`REGION_<KEY>_APP_DATABASE_URL`) from `REGION_KEYS`, which a
      // static AppConfig schema cannot enumerate.
      "src/common/region/region.module.ts",
      // `EnvKeyProvider` discovers key versions by scanning every env name for
      // `ENCRYPTION_KEY_V<n>` — again a set no static schema can declare.
      "src/common/security/envelope-encryption.ts",
      // `forEachOrg` is a plain function with 65 call sites and no injector
      // handle (CLAUDE.md §4 makes it *the* background-sweep iterator, and a
      // sweep has no ambient context); `CELL_ID` names the process, not a
      // tenant, and the read must stay call-time because it selects the
      // enumeration database per sweep — `for-each-org.spec.ts` sets and
      // deletes the variable between tests to prove exactly that.
      "src/common/tenant/for-each-org.ts",
      // The module factory calls `resolvePoolConfig(process.env)` to build the
      // database pool. The DI container that would supply APP_CONFIG is itself
      // built by this factory, so injection is structurally impossible here —
      // same reason as `admission.config.ts`, one level up in the chain.
      "src/db/drizzle.module.ts",
      // Reads `process.env[variable]` with a runtime-computed key (the pool
      // name string), not a literal. Same architectural reason as
      // `envelope-encryption.ts`: the set of keys cannot be enumerated in a
      // static AppConfig schema.
      "src/degradation/degraded-db.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
  {
    // Ratchet, not an exemption: these predate the config seam and shrink as they migrate.
    files: [
      "src/common/audit/internal-audit.controller.ts",
      "src/common/auth/jwt-auth.guard.ts",
      "src/common/auth/jwt-keyring.service.ts",
      "src/common/cache/cache.module.ts",
      "src/common/http/trust-proxy.ts",
      "src/common/observability/log-span-exporter.ts",
      "src/common/outbox/outbox-delivery-deadline.ts",
      "src/common/portal-auth/portal-jwt-auth.guard.ts",
      "src/common/rbac/platform-operators.ts",
      "src/common/security/legacy-crypto.ts",
      "src/common/security/secret-encryption.util.ts",
      // Region topology reads dynamic REGION_<KEY>_* variables parsed at runtime,
      // so the key set cannot exist in a fixed AppConfig schema. Both
      // resolveRegionTopology and resolvePoolConfig validate their env bag and throw.
      "src/common/region/region.module.ts",
      "src/common/tenant/with-tenant.ts",
      "src/common/testing/repo-paths.ts",
      "src/health/health.controller.ts",
      "src/health/readiness.config.ts",
      "src/modules/ai/confirmation/ai-confirmation.helpers.ts",
      "src/modules/ai/confirmation/ai-confirmation.service.ts",
      "src/modules/ai/core/gateway/ai-stream-model.ts",
      "src/modules/ai/core/providers/embeddings.service.ts",
      "src/modules/ai/core/providers/llm-provider.config.ts",
      "src/modules/ai/core/providers/llm-retry.ts",
      "src/modules/ai/core/services/chat-assistant-model.ts",
      "src/modules/auth/auth.controller.ts",
      "src/modules/billing/core/plan-entitlements.constants.ts",
      "src/modules/billing/payments/payments.controller.ts",
      "src/modules/calendar/calendar-webhook-secret.ts",
      "src/modules/crm/consent/unsubscribe-token.util.ts",
      "src/modules/cron/cron-kb.controller.ts",
      "src/modules/cron/cron-outbox-worker.service.ts",
      "src/modules/cron/cron-retention-scheduler.service.ts",
      "src/modules/cron/cron-secret.ts",
      "src/modules/email/app-url.ts",
      "src/modules/email/branding.ts",
      "src/modules/email/email-webhook.service.ts",
      "src/modules/email/email.constants.ts",
      "src/modules/email/email.provider.ts",
      "src/modules/email/unsubscribe-token.ts",
      "src/modules/expenses/expense-export-worker.service.ts",
      "src/modules/feedbucket/feedbucket-ai.service.ts",
      "src/modules/hr/import/hr-export-jobs.service.ts",
      "src/modules/hr/import/hr-export-jobs.types.ts",
      "src/modules/hr/interviews/hr-interview-scheduling.service.ts",
      "src/modules/hr/onboarding/core/crypto.helpers.ts",
      // Was `src/modules/hr/payroll/lib/encryption.ts`. Payroll became its own
      // top-level module (CLAUDE.md §1) and this entry was never moved with it,
      // so the file has been failing the rule under its real path ever since.
      "src/modules/payroll/hr-payroll/lib/encryption.ts",
      "src/modules/hr/recruitment/recruitment-jobs.service.ts",
      "src/modules/inventory/channels/sync/shopify-admin.adapter.ts",
      "src/modules/inventory/shipments/transport/delhivery-http.adapter.ts",
      "src/modules/mail/providers/mail-cursor-signing.ts",
      "src/modules/mfa/mfa.service.ts",
      "src/modules/notifications/partition-maintenance.service.ts",
      "src/modules/organization/setup/org-setup.service.ts",
      "src/modules/payroll/jobs/payroll-jobs-worker.service.ts",
      "src/modules/payroll/runs/payroll-export-worker.service.ts",
      "src/modules/portal/auth/portal-token.service.ts",
      "src/modules/rbac/permission-catalog-sync.service.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
);
