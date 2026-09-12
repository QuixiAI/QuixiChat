/** Immutable migration: internal transport evidence does not close a text block. */
export const STREAMING_TEXT_MIGRATION = {
  version: 8,
  name: "streaming_text_across_transport_provenance",
  sql: `
DROP TRIGGER quixi_part_append_only;
CREATE TRIGGER quixi_part_append_only BEFORE UPDATE ON quixi_records WHEN OLD.collection='parts' AND (
 json_extract(OLD.payload,'$.kind')!='Text' OR json_type(OLD.payload,'$.data.text')!='text' OR json_type(NEW.payload,'$.data.text') IS NOT 'text' OR
 json_extract(NEW.payload,'$.kind') IS NOT json_extract(OLD.payload,'$.kind') OR
 json_extract(NEW.payload,'$.messageId') IS NOT json_extract(OLD.payload,'$.messageId') OR
 json_extract(NEW.payload,'$.order') IS NOT json_extract(OLD.payload,'$.order') OR
 substr(CAST(json_extract(NEW.payload,'$.data.text') AS BLOB),1,length(CAST(json_extract(OLD.payload,'$.data.text') AS BLOB))) IS NOT CAST(json_extract(OLD.payload,'$.data.text') AS BLOB) OR
 NOT EXISTS(SELECT 1 FROM quixi_records m WHERE m.collection='messages' AND m.id=OLD.message_id AND json_extract(m.payload,'$.sealed')=0) OR
 EXISTS(SELECT 1 FROM quixi_records p WHERE p.collection='parts' AND p.message_id=OLD.message_id
   AND json_extract(p.payload,'$.order')>json_extract(OLD.payload,'$.order')
   AND NOT coalesce(json_extract(p.payload,'$.kind')='ProviderArtifact' AND json_extract(p.payload,'$.data.providerKind') IN('quixi.provider.raw-stream-chunk','quixi.provider.response-manifest'),0))
) BEGIN SELECT RAISE(ABORT,'only unfinished last semantic text part may append its prefix'); END;
`,
} as const;
