export const EXTRACTION_SCHEMA_VERSION = 2;
/** Frozen v1 DDL: only this exact prior schema is eligible for in-place upgrade. */
export const EXTRACTION_SCHEMA_V1 = `
CREATE TABLE quixi_extract_schema(version INTEGER PRIMARY KEY,checksum TEXT NOT NULL) STRICT;
CREATE TABLE quixi_extract_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),revision INTEGER NOT NULL,used_bytes INTEGER NOT NULL CHECK(used_bytes>=0)) STRICT;
CREATE TABLE quixi_extract_documents(document_id TEXT PRIMARY KEY,latest_run TEXT NOT NULL,visible_run TEXT,revision INTEGER NOT NULL) STRICT;
CREATE TABLE quixi_extract_runs(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,identity TEXT NOT NULL,state TEXT NOT NULL,writer_epoch INTEGER NOT NULL,page_count INTEGER,completed_page INTEGER NOT NULL,current_page TEXT,used_bytes INTEGER NOT NULL CHECK(used_bytes>=0),failure TEXT) STRICT;
CREATE INDEX quixi_extract_run_document ON quixi_extract_runs(document_id,id);
CREATE INDEX quixi_extract_run_state ON quixi_extract_runs(state,id);
CREATE TABLE quixi_extract_pages(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,page INTEGER NOT NULL,state TEXT NOT NULL,next_sequence INTEGER NOT NULL,utf16 INTEGER NOT NULL,map_count INTEGER NOT NULL,map_bytes INTEGER NOT NULL,max_item INTEGER NOT NULL,text TEXT,text_sha TEXT,map_sha TEXT,source_digest TEXT,publication_revision INTEGER,classification TEXT,published_bytes INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX quixi_extract_page_run ON quixi_extract_pages(run_id,page,id);
CREATE INDEX quixi_extract_page_cursor ON quixi_extract_pages(run_id,id);
CREATE UNIQUE INDEX quixi_extract_published_page ON quixi_extract_pages(run_id,page) WHERE state='published';
CREATE TABLE quixi_extract_text_batches(page_id TEXT NOT NULL,sequence INTEGER NOT NULL,start_utf16 INTEGER NOT NULL,text TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(page_id,sequence)) STRICT;
CREATE TABLE quixi_extract_map_batches(page_id TEXT NOT NULL,sequence INTEGER NOT NULL,start_utf16 INTEGER NOT NULL,end_utf16 INTEGER NOT NULL,maps TEXT NOT NULL,map_digest TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(page_id,sequence)) STRICT;
CREATE INDEX quixi_extract_map_range ON quixi_extract_map_batches(page_id,end_utf16,sequence);
CREATE TABLE quixi_extract_operations(id TEXT PRIMARY KEY,kind TEXT NOT NULL,digest TEXT NOT NULL,run_id TEXT,result TEXT NOT NULL,bytes INTEGER NOT NULL) STRICT;
CREATE TABLE quixi_extract_cleanup_pages(page_id TEXT PRIMARY KEY) STRICT;
CREATE TABLE quixi_extract_cleanup_runs(run_id TEXT PRIMARY KEY,after_id TEXT NOT NULL) STRICT;
CREATE TABLE quixi_extract_publications(revision INTEGER PRIMARY KEY,document_id TEXT NOT NULL,run_id TEXT NOT NULL,page_id TEXT,kind TEXT NOT NULL) STRICT;
`;

export const EXTRACTION_LAYOUT_SCHEMA = `
CREATE TABLE quixi_extract_page_layout(page_id TEXT PRIMARY KEY,layout TEXT NOT NULL CHECK(length(CAST(layout AS BLOB))<=512)) STRICT;
`;
export const EXTRACTION_SCHEMA = EXTRACTION_SCHEMA_V1 + EXTRACTION_LAYOUT_SCHEMA;
