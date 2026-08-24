import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
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
      "src/modules/hr/payroll/lib/encryption.ts",
      "src/modules/hr/recruitment/recruitment-jobs.service.ts",
      "src/modules/mfa/mfa.service.ts",
      "src/modules/organization/setup/org-setup.service.ts",
      "src/modules/portal/auth/portal-token.service.ts",
    ],
    rules: { "no-restricted-syntax": "off" },
  },
);
