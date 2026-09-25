DO $$
DECLARE
  old_view_id integer;
  old_manage_id integer;
  current_view_id integer;
  current_manage_id integer;
BEGIN
  SELECT id INTO current_view_id FROM permissions WHERE name = 'build:cycles:view';
  SELECT id INTO current_manage_id FROM permissions WHERE name = 'build:cycles:manage';

  IF current_view_id IS NULL OR current_manage_id IS NULL THEN
    RAISE EXCEPTION '1197 rollback precondition: canonical Build iteration permissions are missing';
  END IF;

  INSERT INTO permissions (name, resource, action, description, module_key, administering_module_key, risk_class, is_delegable)
  SELECT 'build:sprints:view', 'build:sprints', action, 'View sprints', module_key, administering_module_key, risk_class, is_delegable
  FROM permissions WHERE id = current_view_id
  ON CONFLICT (name) DO NOTHING;

  INSERT INTO permissions (name, resource, action, description, module_key, administering_module_key, risk_class, is_delegable)
  SELECT 'build:sprints:manage', 'build:sprints', action, 'Manage sprints', module_key, administering_module_key, risk_class, is_delegable
  FROM permissions WHERE id = current_manage_id
  ON CONFLICT (name) DO NOTHING;

  SELECT id INTO old_view_id FROM permissions WHERE name = 'build:sprints:view';
  SELECT id INTO old_manage_id FROM permissions WHERE name = 'build:sprints:manage';

  UPDATE role_permission_grants
  SET permission_key = CASE permission_key
    WHEN 'build:cycles:view' THEN 'build:sprints:view'
    WHEN 'build:cycles:manage' THEN 'build:sprints:manage'
  END
  WHERE permission_key IN ('build:cycles:view', 'build:cycles:manage');

  UPDATE user_permission_grants
  SET permission_key = CASE permission_key
    WHEN 'build:cycles:view' THEN 'build:sprints:view'
    WHEN 'build:cycles:manage' THEN 'build:sprints:manage'
  END
  WHERE permission_key IN ('build:cycles:view', 'build:cycles:manage');

  UPDATE permission_supported_scopes
  SET permission_key = CASE permission_key
    WHEN 'build:cycles:view' THEN 'build:sprints:view'
    WHEN 'build:cycles:manage' THEN 'build:sprints:manage'
  END
  WHERE permission_key IN ('build:cycles:view', 'build:cycles:manage');

  UPDATE user_delegation_permissions
  SET permission_key = CASE permission_key
    WHEN 'build:cycles:view' THEN 'build:sprints:view'
    WHEN 'build:cycles:manage' THEN 'build:sprints:manage'
  END
  WHERE permission_key IN ('build:cycles:view', 'build:cycles:manage');

  UPDATE role_permissions
  SET permission_id = CASE permission_id
    WHEN current_view_id THEN old_view_id
    WHEN current_manage_id THEN old_manage_id
    ELSE permission_id
  END
  WHERE permission_id IN (current_view_id, current_manage_id);

  UPDATE user_permissions
  SET permission_id = CASE permission_id
    WHEN current_view_id THEN old_view_id
    WHEN current_manage_id THEN old_manage_id
    ELSE permission_id
  END
  WHERE permission_id IN (current_view_id, current_manage_id);

  DELETE FROM permissions WHERE id IN (current_view_id, current_manage_id);
END $$;
