import {
  pgTable,
  text,
  timestamp,
  index,
  unique,
  integer,
  decimal,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { organizations, users } from "./auth";

const nodeStatusEnum = ["ACTIVE", "DISABLED", "ARCHIVED"] as const;
type NodeStatus = (typeof nodeStatusEnum)[number];

export const orgBusinessUnits = pgTable(
  "org_business_units",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    code: text("code").notNull(),
    description: text("description"),
    status: text("status").$type<NodeStatus>().default("ACTIVE").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("idx_org_bus_org").on(table.orgId),
    unique("uniq_org_bus_org_code").on(table.orgId, table.code),
  ],
);

export const orgBranches = pgTable(
  "org_branches",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    businessUnitId: text("business_unit_id").references(
      () => orgBusinessUnits.id,
      { onDelete: "set null" },
    ),
    managerUserId: text("manager_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    address: text("address"),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    postalCode: text("postal_code"),
    phone: text("phone"),
    email: text("email"),
    status: text("status").$type<NodeStatus>().default("ACTIVE").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("idx_org_branches_org").on(table.orgId),
    index("idx_org_branches_bu").on(table.businessUnitId),
    unique("uniq_org_branches_org_code").on(table.orgId, table.code),
  ],
);

export const orgDepartments = pgTable(
  "org_departments",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    branchId: text("branch_id").references(() => orgBranches.id, {
      onDelete: "set null",
    }),
    headUserId: text("head_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    description: text("description"),
    status: text("status").$type<NodeStatus>().default("ACTIVE").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("idx_org_depts_org").on(table.orgId),
    index("idx_org_depts_branch").on(table.branchId),
    unique("uniq_org_depts_org_code").on(table.orgId, table.code),
  ],
);

export const orgTeams = pgTable(
  "org_teams",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    departmentId: text("department_id").references(() => orgDepartments.id, {
      onDelete: "set null",
    }),
    leadUserId: text("lead_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    code: text("code").notNull(),
    description: text("description"),
    capacity: integer("capacity"),
    status: text("status").$type<NodeStatus>().default("ACTIVE").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("idx_org_teams_org").on(table.orgId),
    index("idx_org_teams_dept").on(table.departmentId),
    unique("uniq_org_teams_org_code").on(table.orgId, table.code),
  ],
);

export const orgLocations = pgTable(
  "org_locations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    name: text("name").notNull(),
    type: text("type")
      .$type<"OFFICE" | "WAREHOUSE" | "STORE" | "FACTORY" | "REMOTE">()
      .default("OFFICE")
      .notNull(),
    address: text("address"),
    latitude: decimal("latitude", { precision: 10, scale: 7 }),
    longitude: decimal("longitude", { precision: 10, scale: 7 }),
    status: text("status").$type<NodeStatus>().default("ACTIVE").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [index("idx_org_locations_org").on(table.orgId)],
);

export const orgCostCenters = pgTable(
  "org_cost_centers",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status").$type<NodeStatus>().default("ACTIVE").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [
    index("idx_org_cc_org").on(table.orgId),
    unique("uniq_org_cc_org_code").on(table.orgId, table.code),
  ],
);

export const orgBusinessUnitsRelations = relations(
  orgBusinessUnits,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [orgBusinessUnits.orgId],
      references: [organizations.id],
    }),
    branches: many(orgBranches),
  }),
);

export const orgBranchesRelations = relations(orgBranches, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [orgBranches.orgId],
    references: [organizations.id],
  }),
  businessUnit: one(orgBusinessUnits, {
    fields: [orgBranches.businessUnitId],
    references: [orgBusinessUnits.id],
  }),
  manager: one(users, {
    fields: [orgBranches.managerUserId],
    references: [users.id],
  }),
  departments: many(orgDepartments),
}));

export const orgDepartmentsRelations = relations(
  orgDepartments,
  ({ one, many }) => ({
    organization: one(organizations, {
      fields: [orgDepartments.orgId],
      references: [organizations.id],
    }),
    branch: one(orgBranches, {
      fields: [orgDepartments.branchId],
      references: [orgBranches.id],
    }),
    head: one(users, {
      fields: [orgDepartments.headUserId],
      references: [users.id],
    }),
    teams: many(orgTeams),
  }),
);

export const orgTeamsRelations = relations(orgTeams, ({ one }) => ({
  organization: one(organizations, {
    fields: [orgTeams.orgId],
    references: [organizations.id],
  }),
  department: one(orgDepartments, {
    fields: [orgTeams.departmentId],
    references: [orgDepartments.id],
  }),
  lead: one(users, {
    fields: [orgTeams.leadUserId],
    references: [users.id],
  }),
}));
