import {
  pgTable,
  text,
  serial,
  timestamp,
  boolean,
  jsonb,
  integer,
  index,
  uniqueIndex,
  unique,
} from "drizzle-orm/pg-core";
import { organizations } from "./common/auth";

export type CustomFieldSettings = {
  helpText?: string;
  placeholder?: string;
  defaultValue?: unknown;
  validationRules?: {
    minLength?: number;
    maxLength?: number;
    minValue?: number;
    maxValue?: number;
    allowedOptions?: string[];
    dateMin?: string;
    dateMax?: string;
  };
  visibility?: {
    hrOnly?: boolean;
    managerVisible?: boolean;
    selfServiceVisible?: boolean;
    hiddenFromExports?: boolean;
  };
  searchable?: boolean;
  reportable?: boolean;
};

export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: serial("id").primaryKey(),
    orgId: text("org_id")
      .references(() => organizations.id, { onDelete: "cascade" })
      .notNull(),
    entityType: text("entity_type").notNull(),
    projectId: integer("project_id").notNull().default(0),
    key: text("key").notNull(),
    label: text("label").notNull(),
    fieldType: text("field_type").notNull(),
    options: jsonb("options").$type<Array<{ label: string; value: string }>>(),
    settings: jsonb("settings").$type<CustomFieldSettings>(),
    isSensitive: boolean("is_sensitive").default(false).notNull(),
    isRequired: boolean("is_required").default(false).notNull(),
    category: text("category"),
    isActive: boolean("is_active").default(true).notNull(),
    displayOrder: integer("display_order").default(0).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .notNull()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("uniq_cfd_org_entity_project_key").on(
      table.orgId,
      table.entityType,
      table.projectId,
      table.key,
    ),
    index("idx_cfd_org_entity_project_active").on(
      table.orgId,
      table.entityType,
      table.projectId,
      table.isActive,
    ),
    unique("uniq_cfd_org_id").on(table.orgId, table.id),
  ],
);
