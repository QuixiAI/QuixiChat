/** Immutable local protocol metadata. Its rows are not portable canonical
 * history and must not be erased with repairable extraction/search data. */
export const OPERATION_CLAIMS_MIGRATION = {
  version: 10,
  name: 'stable_local_operation_claims',
  sql: `
CREATE TABLE quixi_local_operation_claims(
 operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=36),
 domain TEXT NOT NULL CHECK(length(domain) BETWEEN 1 AND 64 AND substr(domain,1,1) BETWEEN 'a' AND 'z' AND domain NOT GLOB '*[^a-z0-9._-]*'),
 request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
 identity_digest TEXT NOT NULL CHECK(length(identity_digest)=64 AND identity_digest NOT GLOB '*[^0-9a-f]*')
) STRICT;
CREATE TRIGGER quixi_local_claims_no_update BEFORE UPDATE ON quixi_local_operation_claims
 BEGIN SELECT RAISE(ABORT,'local operation claims are immutable'); END;
CREATE TRIGGER quixi_local_claims_no_delete BEFORE DELETE ON quixi_local_operation_claims
 BEGIN SELECT RAISE(ABORT,'local operation claims are immutable'); END;
CREATE TRIGGER quixi_local_claims_no_replace BEFORE INSERT ON quixi_local_operation_claims
 WHEN EXISTS(SELECT 1 FROM quixi_local_operation_claims WHERE operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'local operation claim identity already exists'); END;
CREATE TRIGGER quixi_local_claims_existing_journal BEFORE INSERT ON quixi_local_operation_claims WHEN
 EXISTS(SELECT 1 FROM quixi_sync_ops WHERE operation_id=NEW.operation_id) OR
 EXISTS(SELECT 1 FROM quixi_import_operations WHERE operation_id=NEW.operation_id) OR
 EXISTS(SELECT 1 FROM quixi_import_record_identities WHERE operation_id=NEW.operation_id) OR
 EXISTS(SELECT 1 FROM quixi_blob_operations WHERE operation_id=NEW.operation_id) OR
 EXISTS(SELECT 1 FROM quixi_import_work_operations WHERE operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'local operation identity already belongs to another journal'); END;
CREATE TRIGGER quixi_sync_ops_local_claim BEFORE INSERT ON quixi_sync_ops
 WHEN EXISTS(SELECT 1 FROM quixi_local_operation_claims WHERE operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'operation identity reserved by durable local claim'); END;
CREATE TRIGGER quixi_import_operations_local_claim BEFORE INSERT ON quixi_import_operations
 WHEN EXISTS(SELECT 1 FROM quixi_local_operation_claims WHERE operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'operation identity reserved by durable local claim'); END;
CREATE TRIGGER quixi_import_record_identities_local_claim BEFORE INSERT ON quixi_import_record_identities
 WHEN EXISTS(SELECT 1 FROM quixi_local_operation_claims WHERE operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'operation identity reserved by durable local claim'); END;
CREATE TRIGGER quixi_blob_operations_local_claim BEFORE INSERT ON quixi_blob_operations
 WHEN EXISTS(SELECT 1 FROM quixi_local_operation_claims WHERE operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'operation identity reserved by durable local claim'); END;
CREATE TRIGGER quixi_import_work_operations_local_claim BEFORE INSERT ON quixi_import_work_operations
 WHEN EXISTS(SELECT 1 FROM quixi_local_operation_claims WHERE operation_id=NEW.operation_id)
 BEGIN SELECT RAISE(ABORT,'operation identity reserved by durable local claim'); END;
`,
} as const;
