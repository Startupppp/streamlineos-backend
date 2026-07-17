CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_jl_org_entry ON journal_lines (org_id, entry_id);
CREATE INDEX IF NOT EXISTS idx_je_org_status_entry_date ON journal_entries (org_id, status, entry_date);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_trgm ON audit_logs USING gin (action gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_inv_products_name_trgm_gin ON inv_products USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_inv_products_sku_trgm_gin ON inv_products USING gin (sku gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_inv_variants_sku_trgm_gin ON inv_product_variants USING gin (sku gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_hr_people_firstname_trgm ON hr_people USING gin (first_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hr_people_lastname_trgm ON hr_people USING gin (last_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hr_people_email_trgm ON hr_people USING gin (work_email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_leads_city_trgm ON leads USING gin (city gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_users_designation_trgm ON users USING gin (designation gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hr_cases_summary_trgm ON hr_cases USING gin (summary gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_hr_cases_case_number_trgm ON hr_cases USING gin (case_number gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_inv_txn_org_type_created_desc ON inv_stock_transactions (org_id, transaction_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ticket_activity_log_org_ticket ON ticket_activity_log (org_id, ticket_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_payroll_run_employees_run_status ON payroll_run_employees (run_id, status);
CREATE INDEX IF NOT EXISTS idx_payroll_line_items_run_emp_sort ON payroll_line_items (run_id, run_employee_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_notifications_user_unread_partial ON notifications (user_id, org_id) WHERE is_read = false AND deleted_at IS NULL AND archived_at IS NULL;
