export const VIEW_MIGRATION = { version: 7, name: 'local_workspace_and_message_recency', sql: `
CREATE TABLE quixi_local_state(key TEXT PRIMARY KEY,value TEXT NOT NULL CHECK(json_valid(value) AND length(CAST(value AS BLOB))<=16384)) STRICT;
CREATE INDEX quixi_message_recency ON quixi_records(thread_id,coalesce(json_extract(payload,'$.createdAt'),json_extract(payload,'$.recordedAt')) DESC,id DESC) WHERE collection='messages';
` } as const;
