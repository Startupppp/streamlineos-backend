ALTER TYPE assignment_rule_type ADD VALUE IF NOT EXISTS 'weighted_round_robin';
ALTER TYPE assignment_rule_type ADD VALUE IF NOT EXISTS 'least_loaded';
ALTER TYPE assignment_rule_type ADD VALUE IF NOT EXISTS 'territory';

ALTER TABLE lead_scoring_rules ADD COLUMN IF NOT EXISTS dimension text NOT NULL DEFAULT 'fit';
