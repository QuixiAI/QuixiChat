import { SUMMARY_PROPOSALS_MIGRATION } from './summary-proposals.ts';
import { LIBRARY_ACTIVITY_MIGRATION } from './library-activity.ts';
import {PRODUCER_MIGRATION} from './producers.ts';
import {VIEW_MIGRATION} from './views.ts';
import {STREAMING_TEXT_MIGRATION} from './streaming-text.ts';
import {ARCHIVE_ACCESS_MIGRATION} from './archive-access.ts';
import {OPERATION_CLAIMS_MIGRATION} from './operation-claims.ts';
import {CONTEXT_COMPACTION_MIGRATION} from './context-compaction.ts';
/** Ordered, immutable canonical migrations; A1 proof user_version is independent. */
export const CANONICAL_MIGRATIONS = [
  { version:1, name:'canonical_records_and_atomic_operations', sql:`
CREATE TABLE quixi_records(
  collection TEXT NOT NULL, id TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=262144),
  thread_id TEXT GENERATED ALWAYS AS(CASE WHEN collection='threads' THEN id ELSE json_extract(payload,'$.threadId') END) STORED,
  parent_id TEXT GENERATED ALWAYS AS(json_extract(payload,'$.parentId')) STORED,
  message_id TEXT GENERATED ALWAYS AS(json_extract(payload,'$.messageId')) STORED,
  generation_id TEXT GENERATED ALWAYS AS(json_extract(payload,'$.generationId')) STORED,
  PRIMARY KEY(collection,id)
) STRICT;
CREATE UNIQUE INDEX quixi_global_identity ON quixi_records(id) WHERE collection!='threadStates';
CREATE INDEX quixi_thread_records ON quixi_records(collection,thread_id,id);
CREATE INDEX quixi_message_children ON quixi_records(parent_id,id) WHERE collection='messages';
CREATE INDEX quixi_message_parts ON quixi_records(message_id,id) WHERE collection='parts';
CREATE TABLE quixi_edges(
  owner_collection TEXT NOT NULL, owner_id TEXT NOT NULL, field TEXT NOT NULL,
  target_collection TEXT NOT NULL, target_id TEXT NOT NULL,
  PRIMARY KEY(owner_collection,owner_id,field),
  FOREIGN KEY(owner_collection,owner_id) REFERENCES quixi_records(collection,id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(target_collection,target_id) REFERENCES quixi_records(collection,id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX quixi_reference_targets ON quixi_edges(target_collection,target_id,owner_collection,owner_id);
CREATE TABLE quixi_sync_ops(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, recorded_at INTEGER NOT NULL,
  identity TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
  affects TEXT NOT NULL CHECK(json_valid(affects)), result TEXT NOT NULL CHECK(json_valid(result))
) STRICT;
CREATE TABLE quixi_transactions(
  transaction_id TEXT PRIMARY KEY, identity TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result))
) STRICT;
` },
  { version:2, name:'source_and_generation_uniqueness', sql:`
CREATE UNIQUE INDEX quixi_native_source_identity ON quixi_records(
 json_extract(payload,'$.provider'),json_extract(payload,'$.accountScope'),
 coalesce(json_extract(payload,'$.sourceThreadId'),''),json_extract(payload,'$.sourceContainerKey'),json_extract(payload,'$.entityKind'),json_extract(payload,'$.nativeId')
) WHERE collection='sourceIdentities';
CREATE UNIQUE INDEX quixi_generation_output ON quixi_records(json_extract(payload,'$.outputMessageId')) WHERE collection='generations';
CREATE UNIQUE INDEX quixi_output_generation ON quixi_records(generation_id) WHERE collection='messages' AND generation_id IS NOT NULL;
CREATE UNIQUE INDEX quixi_part_order ON quixi_records(message_id,json_extract(payload,'$.order')) WHERE collection='parts';
CREATE INDEX quixi_generation_status ON quixi_records(json_extract(payload,'$.status'),id) WHERE collection='generations';
CREATE INDEX quixi_blob_references ON quixi_records(json_extract(payload,'$.blobSha256')) WHERE collection='attachments';
CREATE INDEX quixi_raw_references ON quixi_records(json_extract(payload,'$.sha256')) WHERE collection='rawObjects';
CREATE TRIGGER quixi_identity_immutable BEFORE UPDATE ON quixi_records
WHEN NEW.collection!=OLD.collection OR NEW.id!=OLD.id
BEGIN SELECT RAISE(ABORT,'canonical identity is immutable'); END;
CREATE TRIGGER quixi_sealed_records BEFORE UPDATE ON quixi_records
WHEN OLD.collection IN('threads','contexts','events','rawObjects','importSources','sourceIdentities','provenance','tombstones')
BEGIN SELECT RAISE(ABORT,'canonical record is immutable'); END;
CREATE TRIGGER quixi_message_immutable BEFORE UPDATE ON quixi_records WHEN OLD.collection='messages' AND (
 json_extract(OLD.payload,'$.sealed')=1 OR
 json_extract(NEW.payload,'$.threadId') IS NOT json_extract(OLD.payload,'$.threadId') OR
 json_extract(NEW.payload,'$.parentId') IS NOT json_extract(OLD.payload,'$.parentId') OR
 json_extract(NEW.payload,'$.role') IS NOT json_extract(OLD.payload,'$.role') OR
 json_extract(NEW.payload,'$.generationId') IS NOT json_extract(OLD.payload,'$.generationId') OR
 json_extract(NEW.payload,'$.editedFromMessageId') IS NOT json_extract(OLD.payload,'$.editedFromMessageId') OR
 json_extract(NEW.payload,'$.createdAt') IS NOT json_extract(OLD.payload,'$.createdAt') OR
 json_extract(NEW.payload,'$.recordedAt') IS NOT json_extract(OLD.payload,'$.recordedAt')
) BEGIN SELECT RAISE(ABORT,'message identity and sealed content are immutable'); END;
CREATE TRIGGER quixi_part_append_only BEFORE UPDATE ON quixi_records WHEN OLD.collection='parts' AND (
 json_extract(OLD.payload,'$.kind')!='Text' OR json_type(OLD.payload,'$.data.text')!='text' OR json_type(NEW.payload,'$.data.text') IS NOT 'text' OR
 json_extract(NEW.payload,'$.kind') IS NOT json_extract(OLD.payload,'$.kind') OR
 json_extract(NEW.payload,'$.messageId') IS NOT json_extract(OLD.payload,'$.messageId') OR
 json_extract(NEW.payload,'$.order') IS NOT json_extract(OLD.payload,'$.order') OR
 substr(json_extract(NEW.payload,'$.data.text'),1,length(json_extract(OLD.payload,'$.data.text'))) IS NOT json_extract(OLD.payload,'$.data.text') OR
 NOT EXISTS(SELECT 1 FROM quixi_records m WHERE m.collection='messages' AND m.id=OLD.message_id AND json_extract(m.payload,'$.sealed')=0 AND json_extract(m.payload,'$.partCount')-1=json_extract(OLD.payload,'$.order'))
) BEGIN SELECT RAISE(ABORT,'only unfinished last text part may append its prefix'); END;
CREATE TRIGGER quixi_generation_sealed BEFORE UPDATE ON quixi_records WHEN OLD.collection='generations' AND (
 json_extract(OLD.payload,'$.status')!='streaming' OR
 json_extract(NEW.payload,'$.threadId') IS NOT json_extract(OLD.payload,'$.threadId') OR
 json_extract(NEW.payload,'$.parentMessageId') IS NOT json_extract(OLD.payload,'$.parentMessageId') OR
 json_extract(NEW.payload,'$.outputMessageId') IS NOT json_extract(OLD.payload,'$.outputMessageId') OR
 json_extract(NEW.payload,'$.contextSnapshotId') IS NOT json_extract(OLD.payload,'$.contextSnapshotId') OR
 json_extract(NEW.payload,'$.provider') IS NOT json_extract(OLD.payload,'$.provider') OR
 json_extract(NEW.payload,'$.providerAccountId') IS NOT json_extract(OLD.payload,'$.providerAccountId') OR
 json_extract(NEW.payload,'$.model') IS NOT json_extract(OLD.payload,'$.model') OR
 json_extract(NEW.payload,'$.parameters') IS NOT json_extract(OLD.payload,'$.parameters')
) BEGIN SELECT RAISE(ABORT,'generation context and terminal output are immutable'); END;
CREATE TRIGGER quixi_state_revision BEFORE UPDATE ON quixi_records WHEN OLD.collection='threadStates' AND
 json_extract(NEW.payload,'$.revision')!=json_extract(OLD.payload,'$.revision')+1
BEGIN SELECT RAISE(ABORT,'thread revision must advance once'); END;
CREATE TRIGGER quixi_attachment_bytes BEFORE UPDATE ON quixi_records WHEN OLD.collection='attachments' AND json_extract(OLD.payload,'$.availability')='available' AND (
 json_extract(NEW.payload,'$.blobSha256') IS NOT json_extract(OLD.payload,'$.blobSha256') OR
 json_extract(NEW.payload,'$.sizeBytes') IS NOT json_extract(OLD.payload,'$.sizeBytes') OR
 json_extract(NEW.payload,'$.availability')!='available'
) BEGIN SELECT RAISE(ABORT,'published attachment bytes are immutable'); END;

` },
  { version:3, name:'verified_blob_catalog_and_transfer_recovery', sql:`
CREATE TABLE quixi_blob_catalog(
  sha256 TEXT PRIMARY KEY CHECK(length(sha256)=64),
  byte_length INTEGER NOT NULL CHECK(byte_length>=0),
  utf8_verified INTEGER NOT NULL CHECK(utf8_verified IN(0,1)),
  availability TEXT NOT NULL DEFAULT 'verified' CHECK(availability IN('verified','unverified')),
  verification_epoch TEXT NOT NULL DEFAULT ''
) STRICT;
CREATE TABLE quixi_blob_transfers(
  id TEXT PRIMARY KEY, purpose TEXT NOT NULL, state TEXT NOT NULL,
  sha256 TEXT, byte_length INTEGER, utf8_verified INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE quixi_blob_operations(
  operation_id TEXT PRIMARY KEY, identity TEXT NOT NULL, result TEXT NOT NULL
) STRICT;
` },
  { version:4, name:'hidden_normalized_import_groups', sql:`
CREATE TABLE quixi_import_jobs(
 id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN('create','extend')),
 expected_revision INTEGER, recorded_at INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN('staging','validating','ready','publishing','published','cancelled')),
 next_sequence INTEGER NOT NULL DEFAULT 0, record_count INTEGER NOT NULL DEFAULT 0,
 manifest_digest TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000',
 topology_remaining INTEGER NOT NULL DEFAULT 0,
 validation_cursor INTEGER NOT NULL DEFAULT -1, validation_phase TEXT NOT NULL DEFAULT 'topology',
 validation_high_water INTEGER NOT NULL DEFAULT -1, publication_operation_id TEXT
) STRICT;
CREATE UNIQUE INDEX quixi_import_new_thread ON quixi_import_jobs(thread_id) WHERE mode='create' AND state NOT IN('published','cancelled');
CREATE TABLE quixi_import_records(
 import_id TEXT NOT NULL REFERENCES quixi_import_jobs(id), ordinal INTEGER NOT NULL,
 collection TEXT NOT NULL, id TEXT NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=262144),
 operation_id TEXT NOT NULL UNIQUE, recorded_at INTEGER NOT NULL, identity TEXT NOT NULL,
 sync_payload TEXT NOT NULL, affects TEXT NOT NULL,
 thread_id TEXT GENERATED ALWAYS AS(CASE WHEN collection='threads' THEN id ELSE json_extract(payload,'$.threadId') END) STORED,
 parent_id TEXT GENERATED ALWAYS AS(json_extract(payload,'$.parentId')) STORED,
 edited_from TEXT GENERATED ALWAYS AS(json_extract(payload,'$.editedFromMessageId')) STORED,
 message_id TEXT GENERATED ALWAYS AS(json_extract(payload,'$.messageId')) STORED,
 generation_id TEXT GENERATED ALWAYS AS(json_extract(payload,'$.generationId')) STORED,
 pending_links INTEGER NOT NULL DEFAULT 0, topology_checked INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(import_id,collection,id), UNIQUE(import_id,ordinal)
) STRICT;
CREATE INDEX quixi_record_identity_lookup ON quixi_records(id,collection);
CREATE INDEX quixi_import_identity_lookup ON quixi_import_records(id,collection,import_id);
CREATE UNIQUE INDEX quixi_import_global_id ON quixi_import_records(id) WHERE collection!='threadStates';
CREATE INDEX quixi_import_thread ON quixi_import_records(import_id,collection,thread_id,id);
CREATE INDEX quixi_import_parent ON quixi_import_records(import_id,parent_id) WHERE collection='messages';
CREATE INDEX quixi_import_edit ON quixi_import_records(import_id,edited_from) WHERE collection='messages';
CREATE INDEX quixi_import_topology ON quixi_import_records(import_id,pending_links,ordinal) WHERE collection='messages' AND topology_checked=0;
CREATE UNIQUE INDEX quixi_import_part_order ON quixi_import_records(message_id,json_extract(payload,'$.order')) WHERE collection='parts';
CREATE UNIQUE INDEX quixi_import_generation_output ON quixi_import_records(json_extract(payload,'$.outputMessageId')) WHERE collection='generations';
CREATE UNIQUE INDEX quixi_import_output_generation ON quixi_import_records(generation_id) WHERE collection='messages' AND generation_id IS NOT NULL;
CREATE UNIQUE INDEX quixi_import_source_identity ON quixi_import_records(
 json_extract(payload,'$.provider'),json_extract(payload,'$.accountScope'),
 coalesce(json_extract(payload,'$.sourceThreadId'),''),json_extract(payload,'$.sourceContainerKey'),json_extract(payload,'$.entityKind'),json_extract(payload,'$.nativeId')
) WHERE collection='sourceIdentities';
CREATE TABLE quixi_import_edges(
 import_id TEXT NOT NULL REFERENCES quixi_import_jobs(id),
 owner_collection TEXT NOT NULL, owner_id TEXT NOT NULL, field TEXT NOT NULL,
 target_collection TEXT NOT NULL, target_id TEXT NOT NULL,
 PRIMARY KEY(import_id,owner_collection,owner_id,field)
) STRICT;
CREATE TABLE quixi_import_blob_transfers(
 import_id TEXT NOT NULL REFERENCES quixi_import_jobs(id), transfer_id TEXT NOT NULL,
 PRIMARY KEY(import_id,transfer_id)
) STRICT;
CREATE INDEX quixi_import_transfer_owners ON quixi_import_blob_transfers(transfer_id,import_id);
CREATE TABLE quixi_import_record_identities(
 operation_id TEXT PRIMARY KEY, import_id TEXT NOT NULL REFERENCES quixi_import_jobs(id), identity TEXT NOT NULL
) STRICT;
CREATE TABLE quixi_import_operations(
 operation_id TEXT PRIMARY KEY, import_id TEXT NOT NULL REFERENCES quixi_import_jobs(id),
 identity TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result))
) STRICT;
-- Ordinary writes may not steal identities reserved by an unpublished group.
CREATE TRIGGER quixi_import_identity_fence BEFORE INSERT ON quixi_records WHEN EXISTS(
 SELECT 1 FROM quixi_import_records s JOIN quixi_import_jobs j ON j.id=s.import_id
 WHERE j.state!='publishing' AND s.id=NEW.id AND (s.collection=NEW.collection OR(s.collection!='threadStates' AND NEW.collection!='threadStates'))
) BEGIN SELECT RAISE(ABORT,'identity reserved by normalized import'); END;
CREATE TRIGGER quixi_import_source_fence BEFORE INSERT ON quixi_records WHEN NEW.collection='sourceIdentities' AND EXISTS(
 SELECT 1 FROM quixi_import_records s JOIN quixi_import_jobs j ON j.id=s.import_id
 WHERE j.state!='publishing' AND s.collection='sourceIdentities'
 AND json_extract(s.payload,'$.provider')=json_extract(NEW.payload,'$.provider')
 AND json_extract(s.payload,'$.accountScope')=json_extract(NEW.payload,'$.accountScope')
 AND coalesce(json_extract(s.payload,'$.sourceThreadId'),'')=coalesce(json_extract(NEW.payload,'$.sourceThreadId'),'')
 AND json_extract(s.payload,'$.sourceContainerKey')=json_extract(NEW.payload,'$.sourceContainerKey')
 AND json_extract(s.payload,'$.entityKind')=json_extract(NEW.payload,'$.entityKind')
 AND json_extract(s.payload,'$.nativeId')=json_extract(NEW.payload,'$.nativeId')
) BEGIN SELECT RAISE(ABORT,'source identity reserved by normalized import'); END;
CREATE TRIGGER quixi_import_operation_fence BEFORE INSERT ON quixi_sync_ops WHEN
 EXISTS(SELECT 1 FROM quixi_import_operations WHERE operation_id=NEW.operation_id) OR
 EXISTS(SELECT 1 FROM quixi_import_record_identities s JOIN quixi_import_jobs j ON j.id=s.import_id WHERE s.operation_id=NEW.operation_id AND j.state!='publishing')
 BEGIN SELECT RAISE(ABORT,'operation identity reserved by normalized import'); END;
` },
  { version:5, name:'bounded_importer_work_and_uuid_checkpoints', sql:`
CREATE TABLE quixi_import_runs(
 id TEXT PRIMARY KEY, payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=65536)
) STRICT;
CREATE INDEX quixi_import_run_state ON quixi_import_runs(json_extract(payload,'$.state'),id);
CREATE TABLE quixi_import_work_groups(
 run_id TEXT NOT NULL REFERENCES quixi_import_runs(id), group_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('staging','sealed','published','skipped','failed','complete')),
 record_count INTEGER NOT NULL DEFAULT 0, resolved_count INTEGER NOT NULL DEFAULT 0,
 metadata TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata) AND length(CAST(metadata AS BLOB))<=65536),
 report TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(report) AND length(CAST(report AS BLOB))<=65536),
 normalized_import_id TEXT,
 PRIMARY KEY(run_id,group_key)
) STRICT;
CREATE TABLE quixi_import_work(
 run_id TEXT NOT NULL, group_key TEXT NOT NULL, key TEXT NOT NULL, ordinal INTEGER NOT NULL,
 parent_key TEXT, byte_start INTEGER NOT NULL, byte_end INTEGER NOT NULL,
 payload TEXT NOT NULL CHECK(json_valid(payload) AND length(CAST(payload AS BLOB))<=65536),
 result TEXT CHECK(result IS NULL OR(json_valid(result) AND length(CAST(result AS BLOB))<=66560)),
 checkpoint TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(checkpoint) AND length(CAST(checkpoint AS BLOB))<=65536),
 checkpoint_revision INTEGER NOT NULL DEFAULT 0,
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','resolved')),
 pending_links INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(run_id,group_key,key), UNIQUE(run_id,group_key,ordinal),
 FOREIGN KEY(run_id,group_key) REFERENCES quixi_import_work_groups(run_id,group_key)
) STRICT;
CREATE INDEX quixi_import_work_children ON quixi_import_work(run_id,group_key,parent_key);
CREATE INDEX quixi_import_work_ready ON quixi_import_work(run_id,group_key,pending_links,ordinal) WHERE state='pending';
CREATE TABLE quixi_import_allocated_ids(
 run_id TEXT NOT NULL REFERENCES quixi_import_runs(id), key TEXT NOT NULL, id TEXT NOT NULL UNIQUE,
 PRIMARY KEY(run_id,key)
) STRICT;
CREATE TABLE quixi_import_work_operations(
 operation_id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES quixi_import_runs(id),
 identity TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result))
) STRICT;
CREATE TRIGGER quixi_import_work_operation_fence BEFORE INSERT ON quixi_sync_ops WHEN
 EXISTS(SELECT 1 FROM quixi_import_work_operations WHERE operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'operation identity reserved by importer work'); END;
CREATE TRIGGER quixi_blob_sync_operation_fence BEFORE INSERT ON quixi_sync_ops WHEN
 EXISTS(SELECT 1 FROM quixi_blob_operations WHERE operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'operation identity reserved by blob control'); END;
CREATE TRIGGER quixi_blob_control_operation_fence BEFORE INSERT ON quixi_blob_operations WHEN
 EXISTS(SELECT 1 FROM quixi_sync_ops WHERE operation_id=NEW.operation_id) OR
 EXISTS(SELECT 1 FROM quixi_import_operations WHERE operation_id=NEW.operation_id) OR
 EXISTS(SELECT 1 FROM quixi_import_record_identities WHERE operation_id=NEW.operation_id) OR
 EXISTS(SELECT 1 FROM quixi_import_work_operations WHERE operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'operation identity already reserved'); END;

` },
  PRODUCER_MIGRATION,
  VIEW_MIGRATION,
  STREAMING_TEXT_MIGRATION,
  ARCHIVE_ACCESS_MIGRATION,
  OPERATION_CLAIMS_MIGRATION,
  CONTEXT_COMPACTION_MIGRATION,
  SUMMARY_PROPOSALS_MIGRATION,
  LIBRARY_ACTIVITY_MIGRATION,
] as const;
