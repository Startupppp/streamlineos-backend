CREATE UNIQUE INDEX IF NOT EXISTS uniq_ai_credit_packs_name ON ai_credit_packs (name);

INSERT INTO ai_credit_packs (name, credits, bonus_credits, price_in_paise, is_active, sort_order)
VALUES
  ('Starter Pack', 500, 0, 49900, true, 1),
  ('Growth Pack', 2000, 200, 149900, true, 2),
  ('Scale Pack', 5000, 750, 299900, true, 3),
  ('Enterprise Pack', 15000, 3000, 699900, true, 4)
ON CONFLICT (name) DO UPDATE SET
  credits = EXCLUDED.credits,
  bonus_credits = EXCLUDED.bonus_credits,
  price_in_paise = EXCLUDED.price_in_paise,
  is_active = true,
  sort_order = EXCLUDED.sort_order;
