ALTER TABLE "contacts"
  ADD CONSTRAINT "contacts_deal_id_deals_id_fk"
  FOREIGN KEY ("deal_id") REFERENCES "deals"("id") ON DELETE SET NULL;
