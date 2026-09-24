import { text, integer, timestamp, index, unique, foreignKey } from "drizzle-orm/pg-core";
import { build } from "./namespaces";
import { organizations, organizationMembers } from "../common/auth";
import { managedProducts } from "./managed-products";

export const managedProductMemberships = build.table(
  "managed_product_memberships",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    managedProductId: integer("managed_product_id").notNull(),
    organizationMembershipId: integer("organization_membership_id").notNull(),
    role: text("role")
      .$type<"member" | "admin">()
      .default("member")
      .notNull(),
    addedAt: timestamp("added_at").defaultNow().notNull(),
  },
  (t) => [
    unique("uniq_mp_members_org_product_member").on(
      t.orgId,
      t.managedProductId,
      t.organizationMembershipId,
    ),
    index("idx_mp_members_org_product").on(t.orgId, t.managedProductId),
    index("idx_mp_members_membership").on(t.organizationMembershipId),
    foreignKey({
      columns: [t.orgId, t.managedProductId],
      foreignColumns: [managedProducts.orgId, managedProducts.id],
      name: "fk_mp_members_org_product",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.orgId, t.organizationMembershipId],
      foreignColumns: [organizationMembers.orgId, organizationMembers.id],
      name: "fk_mp_members_org_membership",
    }).onDelete("cascade"),
  ],
);
