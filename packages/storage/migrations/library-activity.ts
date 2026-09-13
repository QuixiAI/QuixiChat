/** Schema 13: one materialized row per thread with what the library orders
 * and filters by (pinned, archived, deleted, latest activity), kept by
 * triggers on the canonical rows and read through one ordered index, so a
 * library page costs one index walk instead of a scan and sort of every
 * thread state per item. ADR 0043. The row is derived from canonical
 * records only; the migration backfills it for existing archives. */
const recency = (row: string) => `CAST(coalesce(json_extract(${row}.payload,'$.createdAt'),json_extract(${row}.payload,'$.recordedAt')) AS INTEGER)`;
const stateUpsert = `INSERT INTO quixi_library_activity(thread_id,pinned,archived) VALUES(NEW.id,coalesce(json_extract(NEW.payload,'$.pinned'),0),coalesce(json_extract(NEW.payload,'$.archived'),0))
 ON CONFLICT(thread_id) DO UPDATE SET pinned=excluded.pinned,archived=excluded.archived;`;
export const LIBRARY_ACTIVITY_MIGRATION = { version: 13, name: 'materialized_library_activity', sql: `
CREATE TABLE quixi_library_activity(
 thread_id TEXT PRIMARY KEY,
 created INTEGER NOT NULL DEFAULT 0,
 message_activity INTEGER,
 pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN(0,1)),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)),
 deleted INTEGER NOT NULL DEFAULT 0 CHECK(deleted IN(0,1)),
 activity INTEGER GENERATED ALWAYS AS(coalesce(message_activity,created)) STORED
) STRICT;
CREATE INDEX quixi_library_order ON quixi_library_activity(archived,deleted,pinned DESC,activity DESC,thread_id);
CREATE TRIGGER quixi_library_thread AFTER INSERT ON quixi_records WHEN NEW.collection='threads' BEGIN
 INSERT INTO quixi_library_activity(thread_id,created) VALUES(NEW.id,coalesce(${recency('NEW')},0))
 ON CONFLICT(thread_id) DO UPDATE SET created=excluded.created;
END;
CREATE TRIGGER quixi_library_message AFTER INSERT ON quixi_records WHEN NEW.collection='messages' AND NEW.thread_id IS NOT NULL BEGIN
 INSERT INTO quixi_library_activity(thread_id,message_activity) VALUES(NEW.thread_id,${recency('NEW')})
 ON CONFLICT(thread_id) DO UPDATE SET message_activity=max(coalesce(message_activity,excluded.message_activity),coalesce(excluded.message_activity,message_activity));
END;
CREATE TRIGGER quixi_library_state_insert AFTER INSERT ON quixi_records WHEN NEW.collection='threadStates' BEGIN
 ${stateUpsert}
END;
CREATE TRIGGER quixi_library_state_update AFTER UPDATE OF payload ON quixi_records WHEN NEW.collection='threadStates' BEGIN
 ${stateUpsert}
END;
CREATE TRIGGER quixi_library_tombstone AFTER INSERT ON quixi_records WHEN NEW.collection='tombstones' AND NEW.thread_id IS NOT NULL AND json_extract(NEW.payload,'$.rootMessageId') IS NULL BEGIN
 INSERT INTO quixi_library_activity(thread_id,deleted) VALUES(NEW.thread_id,1)
 ON CONFLICT(thread_id) DO UPDATE SET deleted=1;
END;
INSERT INTO quixi_library_activity(thread_id,created,message_activity,pinned,archived,deleted)
SELECT t.id,coalesce(${recency('t')},0),
 (SELECT max(${recency('m')}) FROM quixi_records m WHERE m.collection='messages' AND m.thread_id=t.id),
 coalesce((SELECT json_extract(s.payload,'$.pinned') FROM quixi_records s WHERE s.collection='threadStates' AND s.id=t.id),0),
 coalesce((SELECT json_extract(s.payload,'$.archived') FROM quixi_records s WHERE s.collection='threadStates' AND s.id=t.id),0),
 EXISTS(SELECT 1 FROM quixi_records d WHERE d.collection='tombstones' AND d.thread_id=t.id AND json_extract(d.payload,'$.rootMessageId') IS NULL)
FROM quixi_records t WHERE t.collection='threads';
` } as const;
