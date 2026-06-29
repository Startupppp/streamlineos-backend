-- Enable pg_trgm extension for fast text search
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
-- Users search indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_name_trgm ON users USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_email_trgm ON users USING gin (email gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_users_employee_id_trgm ON users USING gin (employee_id gin_trgm_ops);
--> statement-breakpoint
-- Leads search indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_name_trgm ON leads USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_email_trgm ON leads USING gin (email gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_company_trgm ON leads USING gin (company gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_phone_trgm ON leads USING gin (phone gin_trgm_ops);
--> statement-breakpoint
-- Deals search indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deals_name_trgm ON deals USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deals_contact_person_trgm ON deals USING gin (contact_person gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deals_contact_email_trgm ON deals USING gin (contact_email gin_trgm_ops);
--> statement-breakpoint
-- Contacts search indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_name_trgm ON contacts USING gin (name gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_email_trgm ON contacts USING gin (email gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_company_trgm ON contacts USING gin (company gin_trgm_ops);
--> statement-breakpoint
-- Tickets search indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tickets_title_trgm ON tickets USING gin (title gin_trgm_ops);
--> statement-breakpoint
-- Projects search indexes
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_name_trgm ON projects USING gin (name gin_trgm_ops);
--> statement-breakpoint
-- Chat messages search index
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_chat_messages_content_trgm ON chat_messages USING gin (content gin_trgm_ops);
