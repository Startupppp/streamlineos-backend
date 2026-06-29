-- Sales quotas for tracking rep targets vs actual revenue
CREATE TABLE IF NOT EXISTS sales_quotas (
  id SERIAL PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  period TEXT NOT NULL DEFAULT 'monthly', -- monthly | quarterly | yearly
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  target_revenue DECIMAL NOT NULL DEFAULT '0',
  actual_revenue DECIMAL NOT NULL DEFAULT '0',
  attainment_pct INTEGER GENERATED ALWAYS AS (
    CASE WHEN target_revenue > 0 THEN ROUND((actual_revenue / target_revenue) * 100)
    ELSE 0 END
  ) STORED,
  notes TEXT,
  set_by_id TEXT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_quotas_org_user ON sales_quotas (org_id, user_id);
CREATE INDEX IF NOT EXISTS idx_sales_quotas_period ON sales_quotas (org_id, start_date, end_date);
