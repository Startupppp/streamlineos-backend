DO $$
DECLARE
  old_view_id integer;
  old_manage_id integer;
BEGIN
  SELECT id INTO old_view_id FROM permissions WHERE name = 'build:sprints:view';
  SELECT id INTO old_manage_id FROM permissions WHERE name = 'build:sprints:manage';

  IF old_view_id IS NULL OR old_manage_id IS NULL THEN
    RAISE EXCEPTION '1197 precondition: legacy Build iteration permissions are missing';
  END IF;

  INSERT INTO permissions (name, resource, action, description, module_key, administering_module_key, risk_class, is_delegable)
  SELECT 'build:cycles:view', 'build:cycles', action, 'View cycles', module_key, administering_module_key, risk_class, is_delegable
  FROM permissions WHERE id = old_view_id
  ON CONFLICT (name) DO NOTHING;

  INSERT INTO permissions (name, resource, action, description, module_key, administering_module_key, risk_class, is_delegable)
  SELECT 'build:cycles:manage', 'build:cycles', action, 'Manage cycles', module_key, administering_module_key, risk_class, is_delegable
  FROM permissions WHERE id = old_manage_id
  ON CONFLICT (name) DO NOTHING;

  DELETE FROM role_permission_grants old_grant
  WHERE old_grant.permission_key IN ('build:sprints:view', 'build:sprints:manage')
    AND EXISTS (
      SELECT 1 FROM role_permission_grants current_grant
      WHERE current_grant.org_id = old_grant.org_id
        AND current_grant.role_id = old_grant.role_id
        AND current_grant.permission_key = CASE old_grant.permission_key
          WHEN 'build:sprints:view' THEN 'build:cycles:view'
          ELSE 'build:cycles:manage'
        END
    );
  UPDATE role_permission_grants
  SET permission_key = CASE permission_key
    WHEN 'build:sprints:view' THEN 'build:cycles:view'
    WHEN 'build:sprints:manage' THEN 'build:cycles:manage'
  END
  WHERE permission_key IN ('build:sprints:view', 'build:sprints:manage');

  DELETE FROM user_permission_grants old_grant
  WHERE old_grant.permission_key IN ('build:sprints:view', 'build:sprints:manage')
    AND EXISTS (
      SELECT 1 FROM user_permission_grants current_grant
      WHERE current_grant.org_id = old_grant.org_id
        AND current_grant.organization_membership_id = old_grant.organization_membership_id
        AND current_grant.permission_key = CASE old_grant.permission_key
          WHEN 'build:sprints:view' THEN 'build:cycles:view'
          ELSE 'build:cycles:manage'
        END
    );
  UPDATE user_permission_grants
  SET permission_key = CASE permission_key
    WHEN 'build:sprints:view' THEN 'build:cycles:view'
    WHEN 'build:sprints:manage' THEN 'build:cycles:manage'
  END
  WHERE permission_key IN ('build:sprints:view', 'build:sprints:manage');

  DELETE FROM permission_supported_scopes old_scope
  WHERE old_scope.permission_key IN ('build:sprints:view', 'build:sprints:manage')
    AND EXISTS (
      SELECT 1 FROM permission_supported_scopes current_scope
      WHERE current_scope.permission_key = CASE old_scope.permission_key
        WHEN 'build:sprints:view' THEN 'build:cycles:view'
        ELSE 'build:cycles:manage'
      END
      AND current_scope.scope = old_scope.scope
    );
  UPDATE permission_supported_scopes
  SET permission_key = CASE permission_key
    WHEN 'build:sprints:view' THEN 'build:cycles:view'
    WHEN 'build:sprints:manage' THEN 'build:cycles:manage'
  END
  WHERE permission_key IN ('build:sprints:view', 'build:sprints:manage');

  DELETE FROM user_delegation_permissions old_grant
  WHERE old_grant.permission_key IN ('build:sprints:view', 'build:sprints:manage')
    AND EXISTS (
      SELECT 1 FROM user_delegation_permissions current_grant
      WHERE current_grant.delegation_id = old_grant.delegation_id
        AND current_grant.permission_key = CASE old_grant.permission_key
          WHEN 'build:sprints:view' THEN 'build:cycles:view'
          ELSE 'build:cycles:manage'
        END
    );
  UPDATE user_delegation_permissions
  SET permission_key = CASE permission_key
    WHEN 'build:sprints:view' THEN 'build:cycles:view'
    WHEN 'build:sprints:manage' THEN 'build:cycles:manage'
  END
  WHERE permission_key IN ('build:sprints:view', 'build:sprints:manage');

  IF to_regclass('role_permissions') IS NOT NULL THEN
    EXECUTE 'UPDATE role_permissions
      SET permission_id = CASE permission_id
        WHEN $1 THEN (SELECT id FROM permissions WHERE name = ''build:cycles:view'')
        WHEN $2 THEN (SELECT id FROM permissions WHERE name = ''build:cycles:manage'')
        ELSE permission_id
      END
      WHERE permission_id IN ($1, $2)'
      USING old_view_id, old_manage_id;
  END IF;

  IF to_regclass('user_permissions') IS NOT NULL THEN
    EXECUTE 'UPDATE user_permissions
      SET permission_id = CASE permission_id
        WHEN $1 THEN (SELECT id FROM permissions WHERE name = ''build:cycles:view'')
        WHEN $2 THEN (SELECT id FROM permissions WHERE name = ''build:cycles:manage'')
        ELSE permission_id
      END
      WHERE permission_id IN ($1, $2)'
      USING old_view_id, old_manage_id;
  END IF;

  DELETE FROM permissions WHERE id IN (old_view_id, old_manage_id);
END $$;
