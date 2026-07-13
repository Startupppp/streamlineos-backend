CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "idx_users_first_name_trgm"
  ON "users" USING gin ("first_name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_users_last_name_trgm"
  ON "users" USING gin ("last_name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_users_designation_trgm"
  ON "users" USING gin ("designation" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_users_full_name_trgm"
  ON "users" USING gin (("first_name" || ' ' || "last_name") gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_contacts_phone_trgm"
  ON "contacts" USING gin ("phone" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_clients_name_trgm"
  ON "clients" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_clients_company_trgm"
  ON "clients" USING gin ("company" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_crm_organizations_name_trgm"
  ON "crm_organizations" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_crm_products_name_trgm"
  ON "crm_products" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_crm_products_sku_trgm"
  ON "crm_products" USING gin ("sku" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_quotes_subject_trgm"
  ON "quotes" USING gin ("subject" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_inv_warehouses_name_trgm"
  ON "inv_warehouses" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_inv_warehouses_code_trgm"
  ON "inv_warehouses" USING gin ("code" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_notifications_title_trgm"
  ON "notifications" USING gin ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_notifications_message_trgm"
  ON "notifications" USING gin ("message" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_purchase_bills_bill_number_trgm"
  ON "purchase_bills" USING gin ("bill_number" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_ledger_accounts_name_trgm"
  ON "ledger_accounts" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_payroll_templates_name_trgm"
  ON "payroll_templates" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_payroll_templates_description_trgm"
  ON "payroll_templates" USING gin ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_salary_components_name_trgm"
  ON "salary_components" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_salary_components_code_trgm"
  ON "salary_components" USING gin ("code" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_survey_forms_title_trgm"
  ON "survey_forms" USING gin ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_survey_forms_description_trgm"
  ON "survey_forms" USING gin ("description" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_workflows_name_trgm"
  ON "workflows" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_support_macros_title_trgm"
  ON "support_macros" USING gin ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_support_macros_body_trgm"
  ON "support_macros" USING gin ("body" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_kb_articles_title_trgm"
  ON "kb_articles" USING gin ("title" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_kb_articles_excerpt_trgm"
  ON "kb_articles" USING gin ("excerpt" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_org_business_units_name_trgm"
  ON "org_business_units" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_org_business_units_code_trgm"
  ON "org_business_units" USING gin ("code" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_org_branches_name_trgm"
  ON "org_branches" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_org_branches_code_trgm"
  ON "org_branches" USING gin ("code" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_org_departments_name_trgm"
  ON "org_departments" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_org_departments_code_trgm"
  ON "org_departments" USING gin ("code" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_org_teams_name_trgm"
  ON "org_teams" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_org_teams_code_trgm"
  ON "org_teams" USING gin ("code" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_org_locations_name_trgm"
  ON "org_locations" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_org_cost_centers_name_trgm"
  ON "org_cost_centers" USING gin ("name" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_org_cost_centers_code_trgm"
  ON "org_cost_centers" USING gin ("code" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "idx_chat_channels_name_trgm"
  ON "chat_channels" USING gin ("name" gin_trgm_ops);
