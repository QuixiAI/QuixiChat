import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { CanonicalSqlite } from "../canonical/repository.ts";
import type { PublishedExtractionSources } from "../extraction/index.ts";
import {
  EXTRACTION_SCHEMA,
  EXTRACTION_SCHEMA_VERSION,
} from "../extraction/schema.ts";
import { rows } from "./sources.ts";

const statements = EXTRACTION_SCHEMA.split(";")
  .map((sql) => sql.replace(/\s+/g, " ").trim())
  .filter(Boolean);
const checksum = bytesToHex(
  sha256(new TextEncoder().encode(EXTRACTION_SCHEMA)),
);
/** All joins are read-only and optional. No canonical trigger or permanent view
 * depends on extraction objects, which can independently fail or be repaired. */
export class ExtractionVisibility {
  private schemaVersion = -1;
  private validSchema = false;
  constructor(
    private readonly db: CanonicalSqlite,
    private readonly sources: PublishedExtractionSources | undefined,
  ) {}
  ready(): boolean {
    try {
      if (!this.sources?.ready()) return false;
      const version = Number(this.db.selectValue("PRAGMA schema_version"));
      if (version !== this.schemaVersion) {
        const objects = rows(
          this.db,
          "SELECT CASE WHEN length(sql)<=8192 THEN sql ELSE NULL END AS sql FROM sqlite_schema WHERE (name GLOB 'quixi_extract_*' OR tbl_name GLOB 'quixi_extract_*') AND sql IS NOT NULL AND type IN('table','index','trigger','view') LIMIT 32",
        );
        this.validSchema =
          objects.length === statements.length &&
          statements.every((sql) =>
            objects.some(
              (row) =>
                typeof row.sql === "string" &&
                row.sql.replace(/\s+/g, " ").trim() === sql,
            ),
          );
        this.schemaVersion = version;
      }
      if (!this.validSchema) return false;
      const ledger = rows(
        this.db,
        "SELECT version,substr(checksum,1,65) AS checksum FROM quixi_extract_schema LIMIT 2",
      );
      return (
        ledger.length === 1 &&
        ledger[0]!.version === EXTRACTION_SCHEMA_VERSION &&
        ledger[0]!.checksum === checksum
      );
    } catch {
      return false;
    }
  }
  predicate(available = true): string {
    if (!available || !this.ready()) return "substr(h.source_key,1,2)<>'e:'";
    return `(substr(h.source_key,1,2)<>'e:' OR (NOT EXISTS(SELECT 1 FROM quixi_search_scopes WHERE scope='extraction_failed' AND id=h.document_id) AND EXISTS(
SELECT 1 FROM quixi_search_page_refs er
JOIN quixi_extract_pages ep ON ep.id=er.page_id AND ep.state='published' AND ep.run_id=er.extraction_run_id AND ep.page=er.page AND ep.source_digest=er.source_digest AND ep.publication_revision=er.publication_revision
JOIN quixi_extract_runs ex ON ex.id=ep.run_id AND ex.document_id=er.document_id AND ex.identity=er.identity
JOIN quixi_extract_documents ed ON ed.document_id=ex.document_id AND ed.visible_run=ex.id
JOIN quixi_records doc ON doc.collection='documents' AND doc.id=er.document_id AND json_extract(doc.payload,'$.attachmentId')=er.attachment_id
JOIN quixi_records att ON att.collection='attachments' AND att.id=er.attachment_id AND json_extract(att.payload,'$.availability')='available' AND json_extract(att.payload,'$.blobSha256')=er.attachment_sha256 AND json_extract(att.payload,'$.sizeBytes')=er.attachment_bytes AND lower(trim(CASE WHEN instr(json_extract(att.payload,'$.mimeType'),';')>0 THEN substr(json_extract(att.payload,'$.mimeType'),1,instr(json_extract(att.payload,'$.mimeType'),';')-1) ELSE json_extract(att.payload,'$.mimeType') END))='application/pdf'
WHERE er.epoch=h.epoch AND er.source_key=h.source_key AND er.run_id=h.run_id)))`;
  }
}
