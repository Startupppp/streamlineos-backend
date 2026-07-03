UPDATE "project_whiteboards" SET "data" = '{"elements": []}'::jsonb WHERE jsonb_typeof("data") = 'array';
