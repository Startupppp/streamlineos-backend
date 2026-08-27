import { randomUUID } from "node:crypto";
import { boolean, index, integer, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organizations } from "../common/auth";

/**
 * The two facts the MCP surface needs that nothing already stores.
 *
 * Phase 6, ticket 19. Neither of these is a credential: the credential is
 * `agent_tokens`, which already exists, already hashes, already expires and
 * already revokes, and this ticket's second criterion says to reuse it rather
 * than build a parallel one. What is stored here is what that table has no
 * column for.
 */

/**
 * Whether an organisation turned the protocol surface on.
 *
 * The last criterion asks for off by default and enabled deliberately per
 * tenant, and the platform already has a mechanism that means exactly that:
 * `org_modules`, where no row means unavailable and a row records who enabled it
 * and when. It was the first choice and it cannot be used, for a reason worth
 * writing down rather than rediscovering.
 *
 * `isCoreModuleKey` in `module-registry.ts` answers TRUE for any key with no
 * registry entry — deliberately, because `settings:` and `ownership:` are
 * platform surfaces with no toggle. A module key like `crm-mcp` that is not in
 * `MODULE_REGISTRY` would therefore resolve as core, hence always available to
 * everyone, which is the exact failure `authorize.ts`'s catalogued-keys check
 * exists to stop: a permission system failing OPEN on input it cannot reason
 * about. Enabling per tenant through `org_modules` therefore requires an entry
 * in `MODULE_REGISTRY` first, and a module registry entry is a product decision
 * about the modules screen, plan gating and the delegation ladder — not
 * something a protocol surface should mint for itself.
 *
 * So: one row per organisation, absent by default, and the row is the record of
 * the decision rather than a boolean somebody flipped. When `crm-mcp` earns a
 * registry entry this table becomes the audit of who first turned it on and the
 * availability check moves to `org_modules`.
 */
export const crmMcpServerEnablement = pgTable("crm_mcp_server_enablement", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  /**
   * Present and false is not the same as absent, and both mean off.
   *
   * A tenant who enabled it and then turned it off keeps the row, so
   * `disabled_by` and `disabled_at` survive. Deleting the row would lose the
   * fact that anyone ever made either decision.
   */
  enabled: boolean("enabled").default(false).notNull(),
  enabledAt: timestamp("enabled_at"),
  /**
   * No FK to `users`, like every other actor column in this series — see
   * `activities.actorUserId` and migration 0223. `scripts/purge-user.mjs`
   * deletes every row whose column references `users`, so offboarding the
   * administrator who enabled the server would delete the enablement itself and
   * silently switch the surface off for the whole tenant.
   */
  enabledBy: text("enabled_by"),
  disabledAt: timestamp("disabled_at"),
  disabledBy: text("disabled_by"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at")
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

/**
 * Which permission keys one agent token may exercise over the protocol.
 *
 * The second criterion asks for scoped, revocable credentials reusing the
 * existing API token model. Revocation and expiry already work: they live on
 * `agent_tokens`, and nothing here duplicates them — revoking the token revokes
 * every grant with it, because the guard never resolves a revoked token at all.
 *
 * Scoping did not work, and the gap is precise. `AgentTokenGuard` resolves a
 * token to a `CurrentUserContext` with `tokenScopes: null`, and null means
 * UNRESTRICTED to `AccessService.scopeFor` — so an agent token inherits its
 * owner's permissions wholesale, and a token issued by an organisation owner
 * holds every permission in the platform. The enforcement machinery is not
 * missing: `scopeFor` honours a non-null `tokenScopes` before it even reaches
 * the owner shortcut, which is how personal access tokens are already scoped.
 * Only the values were missing.
 *
 * This table supplies them. It is an attribute of the existing credential, not a
 * second credential: the row points at `agent_tokens` by its own id, composite
 * on the tenant so a grant can never reach another organisation's token.
 *
 * The right end state is a `scopes` column on `agent_tokens` itself, so every
 * consumer of an agent token is scoped rather than only this one. That is a
 * change to the token model and belongs with it.
 */
export const crmMcpTokenGrants = pgTable(
  "crm_mcp_token_grants",
  {
    crmMcpTokenGrantId: text("crm_mcp_token_grant_id")
      .primaryKey()
      .$defaultFn(() => randomUUID()),
    organizationId: text("organization_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    /** `agent_tokens.id`, reached by the composite `(org_id, id)` key it declares. */
    agentTokenId: integer("agent_token_id").notNull(),
    /**
     * A key from the platform catalogue. Never a key minted for the protocol:
     * a grant naming something `ALL_PERMISSION_NAMES` does not contain is denied
     * by `authorize()` before anything else looks at it, so an uncatalogued
     * grant is dead weight rather than a hole — but it is also a lie on an
     * administrator's screen, so the service refuses to write one.
     */
    permissionKey: text("permission_key").notNull(),
    grantedAt: timestamp("granted_at").defaultNow().notNull(),
    /** No FK to `users`; see `crmMcpServerEnablement.enabledBy`. */
    grantedBy: text("granted_by"),
  },
  (t) => [
    /** The read on every protocol call: this token's whole grant, in one go. */
    index("idx_crm_mcp_token_grants_token").on(t.organizationId, t.agentTokenId),
    unique("uniq_crm_mcp_token_grants_key").on(
      t.organizationId,
      t.agentTokenId,
      t.permissionKey,
    ),
  ],
);
