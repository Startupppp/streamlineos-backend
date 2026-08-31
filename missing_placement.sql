SELECT id FROM organizations WHERE id NOT IN (SELECT organization_id FROM organization_placement);
