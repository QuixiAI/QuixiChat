import { searchDigest, LEXICAL_CHUNKER_VERSION } from "@quixi/search";
/** Lexical policy bounds; the model-aware production policy adds the frozen
 * Arctic tokenizer and a 256-token budget through `searchVersion`. */
export const SEARCH_POLICY = Object.freeze({ maxCharacters: 4096, overlapCharacters: 64, maxTokens: 256 });
export const searchVersion = (chunkerVersion: string) => `fts-v1:${chunkerVersion}:code-v1:nul-space-v1`;
/** Version without a tokenizer: fixtures and hosts that inject none. */
export const SEARCH_VERSION = searchVersion(`${LEXICAL_CHUNKER_VERSION}:${SEARCH_POLICY.maxCharacters}:${SEARCH_POLICY.overlapCharacters}:none:none`);
const epochs =
  "SELECT active_epoch AS epoch FROM quixi_search_meta UNION SELECT rebuilding_epoch FROM quixi_search_meta WHERE rebuilding_epoch IS NOT NULL";
const trigger = (event: "INSERT" | "UPDATE" | "DELETE") => {
  const changed =
    event === "UPDATE"
      ? " AND CASE NEW.collection WHEN 'messages' THEN json_extract(OLD.payload,'$.role') IS NOT json_extract(NEW.payload,'$.role') OR OLD.thread_id IS NOT NEW.thread_id OR json_extract(OLD.payload,'$.createdAt') IS NOT json_extract(NEW.payload,'$.createdAt') OR OLD.generation_id IS NOT NEW.generation_id WHEN 'generations' THEN json_extract(OLD.payload,'$.provider') IS NOT json_extract(NEW.payload,'$.provider') OR json_extract(OLD.payload,'$.model') IS NOT json_extract(NEW.payload,'$.model') WHEN 'threadStates' THEN json_extract(OLD.payload,'$.title') IS NOT json_extract(NEW.payload,'$.title') OR json_extract(OLD.payload,'$.tags') IS NOT json_extract(NEW.payload,'$.tags') ELSE 1 END"
      : "";
  const row = event === "DELETE" ? "OLD" : "NEW";
  const scope = `CASE ${row}.collection WHEN 'parts' THEN 'source' WHEN 'messages' THEN 'message' WHEN 'generations' THEN 'message' WHEN 'threads' THEN 'thread' WHEN 'threadStates' THEN 'thread' WHEN 'tombstones' THEN 'thread' WHEN 'documents' THEN 'document' ELSE 'global' END`;
  const id = `CASE ${row}.collection WHEN 'parts' THEN 'p:'||${row}.id WHEN 'messages' THEN ${row}.id WHEN 'generations' THEN json_extract(${row}.payload,'$.outputMessageId') WHEN 'threads' THEN ${row}.id WHEN 'threadStates' THEN ${row}.thread_id WHEN 'tombstones' THEN ${row}.thread_id WHEN 'documents' THEN ${row}.id ELSE '*' END`;
  return `
CREATE TRIGGER quixi_search_dirty_${event.toLowerCase()} AFTER ${event} ON quixi_records WHEN ${row}.collection IN('parts','messages','generations','threads','threadStates','tombstones','documents','attachments','provenance','importSources')${changed} BEGIN
 UPDATE quixi_search_meta SET revision=revision+1;
 INSERT INTO quixi_search_scopes(scope,id,revision) VALUES(${scope},${id},(SELECT revision FROM quixi_search_meta)) ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision;
 INSERT INTO quixi_search_queue(epoch,scope,id,revision,after_id,failed) SELECT epoch,${scope},${id},(SELECT revision FROM quixi_search_meta),'',0 FROM (${epochs}) WHERE true ON CONFLICT(epoch,scope,id) DO UPDATE SET revision=excluded.revision,after_id='',failed=0;
 INSERT INTO quixi_search_scopes(scope,id,revision) SELECT 'source','f:'||${row}.id,(SELECT revision FROM quixi_search_meta) WHERE ${row}.collection='parts' AND json_extract(${row}.payload,'$.kind')='Image' ON CONFLICT(scope,id) DO UPDATE SET revision=excluded.revision;
 INSERT INTO quixi_search_queue(epoch,scope,id,revision,after_id,failed) SELECT epoch,'source','f:'||${row}.id,(SELECT revision FROM quixi_search_meta),'',0 FROM (${epochs}) WHERE ${row}.collection='parts' AND json_extract(${row}.payload,'$.kind')='Image' ON CONFLICT(epoch,scope,id) DO UPDATE SET revision=excluded.revision,after_id='',failed=0;
END;`;
};
export const SEARCH_SCHEMA = `
CREATE TABLE quixi_search_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version TEXT NOT NULL,active_epoch INTEGER NOT NULL,rebuilding_epoch INTEGER,next_epoch INTEGER NOT NULL,revision INTEGER NOT NULL) STRICT;
CREATE TABLE quixi_search_scopes(scope TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(scope,id)) STRICT;
CREATE TABLE quixi_search_queue(epoch INTEGER NOT NULL,scope TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,after_id TEXT NOT NULL DEFAULT '',failed INTEGER NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(epoch,scope,id)) STRICT;
CREATE TABLE quixi_search_builds(epoch INTEGER NOT NULL,source_key TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(epoch,source_key)) STRICT;
CREATE TABLE quixi_search_heads(epoch INTEGER NOT NULL,source_key TEXT NOT NULL,run_id TEXT NOT NULL,source_type TEXT NOT NULL,source_id TEXT NOT NULL,part_id TEXT,thread_id TEXT,message_id TEXT,document_id TEXT,title TEXT NOT NULL,role TEXT,provider TEXT,model TEXT,date INTEGER,tags TEXT NOT NULL,media_type TEXT NOT NULL,origin TEXT NOT NULL,source_revision INTEGER NOT NULL,message_revision INTEGER NOT NULL,thread_revision INTEGER NOT NULL,document_revision INTEGER NOT NULL,global_revision INTEGER NOT NULL,PRIMARY KEY(epoch,source_key)) STRICT;
CREATE TABLE quixi_search_page_refs(epoch INTEGER NOT NULL,source_key TEXT NOT NULL,run_id TEXT NOT NULL,page_id TEXT NOT NULL,extraction_run_id TEXT NOT NULL,page INTEGER NOT NULL,document_id TEXT NOT NULL,attachment_id TEXT NOT NULL,attachment_sha256 TEXT NOT NULL,attachment_bytes INTEGER NOT NULL,source_digest TEXT NOT NULL,publication_revision INTEGER NOT NULL,identity TEXT NOT NULL,PRIMARY KEY(epoch,source_key)) STRICT;
CREATE INDEX quixi_search_head_thread ON quixi_search_heads(thread_id,source_key);
CREATE INDEX quixi_search_head_document ON quixi_search_heads(document_id,source_key);
CREATE TABLE quixi_search_chunks(rowid INTEGER PRIMARY KEY,epoch INTEGER NOT NULL,source_key TEXT NOT NULL,run_id TEXT NOT NULL,chunk_id TEXT NOT NULL,source_type TEXT NOT NULL,has_code INTEGER NOT NULL,text TEXT NOT NULL,context TEXT NOT NULL,position TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(epoch,run_id,chunk_id)) STRICT;
CREATE INDEX quixi_search_chunk_lookup ON quixi_search_chunks(epoch,chunk_id);
CREATE INDEX quixi_search_chunk_source ON quixi_search_chunks(epoch,source_key,run_id);
CREATE VIRTUAL TABLE quixi_search_fts USING fts5(text,context,content='quixi_search_chunks',content_rowid='rowid',tokenize="unicode61 remove_diacritics 2 tokenchars '_'");
CREATE TRIGGER quixi_search_fts_insert AFTER INSERT ON quixi_search_chunks BEGIN INSERT INTO quixi_search_fts(rowid,text,context) VALUES(NEW.rowid,NEW.text,NEW.context);END;
CREATE TRIGGER quixi_search_fts_delete AFTER DELETE ON quixi_search_chunks BEGIN INSERT INTO quixi_search_fts(quixi_search_fts,rowid,text,context) VALUES('delete',OLD.rowid,OLD.text,OLD.context);END;
CREATE TABLE quixi_search_operations(id TEXT PRIMARY KEY,epoch INTEGER NOT NULL) STRICT;
CREATE TABLE quixi_search_extractions(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,attachment_sha256 TEXT NOT NULL,extractor_version TEXT NOT NULL,text TEXT NOT NULL CHECK(length(text)<=65536),page INTEGER,section_path TEXT NOT NULL,offset_base INTEGER NOT NULL) STRICT;
CREATE INDEX quixi_search_extraction_document ON quixi_search_extractions(document_id,id);
${trigger("INSERT")}${trigger("UPDATE")}${trigger("DELETE")}
`;
export const SEARCH_SCHEMA_CHECKSUM = searchDigest(SEARCH_SCHEMA);
/** Ledger version 2 (2026-09-12): indexes for the indexing queue's pick order.
 * Without them every slice step sorted the whole queue (1.5 ms per step at
 * 19k rows, growing linearly), which made lexical indexing O(n²) at 100k
 * messages. Existing archives gain the indexes in place at open. */
export const SEARCH_QUEUE_INDEX_SCHEMA = `
CREATE INDEX quixi_search_queue_sources ON quixi_search_queue(failed,scope,epoch,id);
CREATE INDEX quixi_search_queue_order ON quixi_search_queue(failed,epoch,scope,id);
`;
export const SEARCH_QUEUE_INDEX_CHECKSUM = searchDigest(SEARCH_QUEUE_INDEX_SCHEMA);
/** Scope generations make stale records invisible without trigger fan-out. */
export const VISIBLE_HEAD = `h.source_revision=coalesce((SELECT revision FROM quixi_search_scopes WHERE scope='source' AND id=h.source_key),0)
AND h.message_revision=coalesce((SELECT revision FROM quixi_search_scopes WHERE scope='message' AND id=h.message_id),0)
AND h.thread_revision=coalesce((SELECT revision FROM quixi_search_scopes WHERE scope='thread' AND id=h.thread_id),0)
AND h.document_revision=coalesce((SELECT revision FROM quixi_search_scopes WHERE scope='document' AND id=h.document_id),0)
AND h.global_revision=coalesce((SELECT revision FROM quixi_search_scopes WHERE scope='global' AND id='*'),0)`;
