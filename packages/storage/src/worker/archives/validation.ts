import { assertSummaryCutoff, readSummaryOutputText, summaryTextDigest } from '../canonical/summary-source.ts';
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  canonicalJson,
  jsonByteLength,
  mutationEffects,
  MUTATION_KINDS,
} from "@quixi/core/contracts";
import type { CanonicalMutation } from "@quixi/core/contracts";
import { contextSummary, SUMMARY_INSTRUCTION, isQuixiId, validateEntityShape } from "@quixi/core/model";
import type {
  CanonicalHistory,
  EntityKind,
  EntityReference,
  JsonValue,
} from "@quixi/core/model";
import type { CanonicalSqlite, SqlValue } from "../canonical/repository.ts";
import { sqlRows } from "./snapshot.ts";
import type { ArchiveManifest } from "./format.ts";
type Collection = Exclude<keyof CanonicalHistory, "version">;
const kinds: Record<Collection, EntityKind> = {
  summaryProposals: "summaryProposal",
  threads: "thread",
  threadStates: "threadState",
  contexts: "context",
  messages: "message",
  generations: "generation",
  parts: "part",
  events: "event",
  attachments: "attachment",
  documents: "document",
  rawObjects: "rawObject",
  importSources: "importSource",
  sourceIdentities: "sourceIdentity",
  provenance: "provenance",
  tombstones: "tombstone",
};
const collections = Object.fromEntries(
  Object.entries(kinds).map(([a, b]) => [b, a]),
) as Record<EntityKind, Collection>;
const encoded = (value: unknown) => canonicalJson(value as JsonValue),
  digest = (value: unknown) =>
    bytesToHex(sha256(new TextEncoder().encode(encoded(value))));
function assert(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
export interface CanonicalArchiveValidationStatus {
  phase:
    | "records"
    | "topology"
    | "intervals"
    | "semantics"
    | "operations"
    | "coverage"
    | "receipts"
    | "ready";
  checkedRecords: number;
  checkedOperations: number;
}
/** Untrusted data is read from a restricted candidate. Only the separate trusted
 * scratch connection is written. Graph queues/stacks/coverage live in SQL. */
export class CanonicalArchiveValidator {
  private phase: CanonicalArchiveValidationStatus["phase"] = "records";
  private cursor: { collection: string; id: string } = {
    collection: "",
    id: "",
  };
  private sequence = 0;
  private receipt = "";
  private checkedRecords = 0;
  private checkedOperations = 0;
  private checkedEdges = 0;
  private topo: { id: string; after: string } | null = null;
  private clock = 0;
  private importTable = 0;
  private importCursor = "";
  private importedIdentities = 0;
  constructor(
    private readonly candidate: CanonicalSqlite,
    private readonly scratch: CanonicalSqlite,
    private readonly jobId: string,
    private readonly manifest: ArchiveManifest,
  ) {
    scratch.exec(`CREATE TEMP TABLE IF NOT EXISTS archive_validation_nodes(job_id TEXT NOT NULL,id TEXT NOT NULL,parent_id TEXT,edited_id TEXT,pending INTEGER NOT NULL,visited INTEGER NOT NULL DEFAULT 0,tin INTEGER,tout INTEGER,PRIMARY KEY(job_id,id)) STRICT;
CREATE INDEX IF NOT EXISTS archive_validation_parent ON archive_validation_nodes(job_id,parent_id,id);
CREATE INDEX IF NOT EXISTS archive_validation_edited ON archive_validation_nodes(job_id,edited_id,id);
CREATE INDEX IF NOT EXISTS archive_validation_ready ON archive_validation_nodes(job_id,pending,visited,id);
CREATE INDEX IF NOT EXISTS archive_validation_roots ON archive_validation_nodes(job_id,parent_id,tin,id);
CREATE TEMP TABLE IF NOT EXISTS archive_validation_stack(job_id TEXT NOT NULL,depth INTEGER NOT NULL,id TEXT NOT NULL,after_child TEXT NOT NULL,PRIMARY KEY(job_id,depth)) STRICT;
CREATE TEMP TABLE IF NOT EXISTS archive_validation_coverage(job_id TEXT NOT NULL,collection TEXT NOT NULL,id TEXT NOT NULL,PRIMARY KEY(job_id,collection,id)) STRICT;
CREATE TEMP TABLE IF NOT EXISTS archive_validation_blobs(job_id TEXT NOT NULL,sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL,utf8 INTEGER NOT NULL,PRIMARY KEY(job_id,sha256)) STRICT;
CREATE TEMP TABLE IF NOT EXISTS archive_validation_parts(job_id TEXT NOT NULL,message_id TEXT NOT NULL,count INTEGER NOT NULL,first INTEGER NOT NULL,last INTEGER NOT NULL,PRIMARY KEY(job_id,message_id)) STRICT;
CREATE TEMP TABLE IF NOT EXISTS archive_validation_tombstones(job_id TEXT NOT NULL,id TEXT NOT NULL,thread_id TEXT NOT NULL,root_id TEXT,PRIMARY KEY(job_id,id)) STRICT;
CREATE INDEX IF NOT EXISTS archive_validation_tombstone_thread ON archive_validation_tombstones(job_id,thread_id);
CREATE TEMP TABLE IF NOT EXISTS archive_validation_imports(job_id TEXT NOT NULL,id TEXT NOT NULL,next_ordinal INTEGER NOT NULL,digest TEXT NOT NULL,published INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(job_id,id)) STRICT;`);
  }
  status(): CanonicalArchiveValidationStatus {
    return {
      phase: this.phase,
      checkedRecords: this.checkedRecords,
      checkedOperations: this.checkedOperations,
    };
  }
  private write(sql: string, bind: SqlValue[] = []) {
    this.scratch.exec({ sql, ...(bind.length ? { bind } : {}) });
  }
  private get<C extends Collection>(
    collection: C,
    id: string,
  ): NonNullable<CanonicalHistory[C]>[number] {
    const row = sqlRows(
      this.candidate,
      "SELECT payload FROM quixi_records WHERE collection=? AND id=?",
      [collection, id],
    )[0];
    assert(row, `Missing canonical reference ${collection}/${id}.`);
    return JSON.parse(String(row.payload));
  }
  private nextRecord() {
    return sqlRows(
      this.candidate,
      "SELECT collection,id,payload FROM quixi_records WHERE (collection,id)>(?,?) ORDER BY collection,id LIMIT 1",
      [this.cursor.collection, this.cursor.id],
    )[0];
  }
  private node(id: string) {
    return sqlRows(
      this.scratch,
      "SELECT * FROM archive_validation_nodes WHERE job_id=? AND id=?",
      [this.jobId, id],
    )[0];
  }
  private ancestor(ancestor: string, descendant: string): boolean {
    const a = this.node(ancestor),
      b = this.node(descendant);
    return (
      !!a &&
      !!b &&
      a.tin !== null &&
      a.tout !== null &&
      Number(a.tin) <= Number(b.tin) &&
      Number(a.tout) >= Number(b.tout)
    );
  }
  private visible(threadId: string, messageId: string): boolean {
    const message = this.node(messageId);
    assert(message, "Selected message has no topology position.");
    return !Number(
      this.scratch.selectValue(
        "SELECT EXISTS(SELECT 1 FROM archive_validation_tombstones t LEFT JOIN archive_validation_nodes n ON n.job_id=t.job_id AND n.id=t.root_id WHERE t.job_id=? AND t.thread_id=? AND (t.root_id IS NULL OR(n.tin<=? AND n.tout>=?)))",
        [this.jobId, threadId, Number(message.tin), Number(message.tout)],
      ),
    );
  }
  private blob(sha256: string, byteLength: number, utf8: boolean) {
    const prior = sqlRows(
      this.scratch,
      "SELECT byte_length FROM archive_validation_blobs WHERE job_id=? AND sha256=?",
      [this.jobId, sha256],
    )[0];
    assert(
      !prior || prior.byte_length === byteLength,
      "Canonical blob lengths conflict.",
    );
    const received = sqlRows(
      this.scratch,
      "SELECT byte_length,sha256 FROM quixi_archive_received_entries WHERE job_id=? AND path=?",
      [this.jobId, "blobs/" + sha256],
    )[0];
    assert(
      received &&
        received.byte_length === byteLength &&
        received.sha256 === sha256,
      "Canonical blob is absent from the verified archive.",
    );
    const catalog = sqlRows(
      this.candidate,
      "SELECT byte_length FROM quixi_blob_catalog WHERE sha256=?",
      [sha256],
    )[0];
    assert(
      catalog && catalog.byte_length === byteLength,
      "Canonical blob catalog does not match its source.",
    );
    this.write(
      "INSERT INTO archive_validation_blobs VALUES(?,?,?,?) ON CONFLICT(job_id,sha256) DO UPDATE SET utf8=max(utf8,excluded.utf8)",
      [this.jobId, sha256, byteLength, utf8 ? 1 : 0],
    );
  }
  private edges(collection: Collection, id: string): void {
    const expected: { field: string; collection: Collection; id: string }[] =
      [];
    const edge = (
      field: string,
      target: Collection,
      targetId: string | null,
      threadId?: string,
    ) => {
      if (targetId === null) return;
      const targetRecord = this.get(target, targetId);
      if (threadId !== undefined)
        assert(
          "threadId" in targetRecord && targetRecord.threadId === threadId,
          `Cross-thread ${field}.`,
        );
      expected.push({ field, collection: target, id: targetId });
    };
    switch (collection) {
      case "summaryProposals": {
        const r=this.get(collection,id);edge('threadId','threads',r.threadId);edge('generationId','generations',r.generationId,r.threadId);
        for(const key of ['sourceContextSnapshotId','requestContextSnapshotId'] as const)edge(key,'contexts',r[key],r.threadId);
        for(const key of ['throughMessageId','sourceLeafMessageId'] as const)edge(key,'messages',r[key],r.threadId);
        edge('baseSummaryProposalId','summaryProposals',r.baseSummaryProposalId,r.threadId);edge('baseSummaryContextId','contexts',r.baseSummaryContextId,r.threadId);edge('inputRawObjectId','rawObjects',r.inputRawObjectId);break;
      }
      case "threads": {
        const r = this.get(collection, id);
        edge("state", "threadStates", r.id);
        edge("importSourceId", "importSources", r.importSourceId);
        break;
      }
      case "threadStates": {
        const r = this.get(collection, id);
        edge("threadId", "threads", r.threadId);
        edge("contextSnapshotId", "contexts", r.contextSnapshotId, r.threadId);
        edge(
          "activeLeafMessageId",
          "messages",
          r.activeLeafMessageId,
          r.threadId,
        );
        break;
      }
      case "contexts": {
        const r = this.get(collection, id);
        edge("threadId", "threads", r.threadId);
        edge("previousId", "contexts", r.previousId, r.threadId);
        for (const [index, partId] of (r.compaction?.excludedPartIds ?? []).entries())
          edge(`compaction.excludedPartIds[${index}]`, "parts", partId);
        const summary=contextSummary(r);if(summary){edge('compaction.summary.proposalId','summaryProposals',summary.proposalId,r.threadId);edge('compaction.summary.throughMessageId','messages',summary.throughMessageId,r.threadId);}
        break;
      }
      case "messages": {
        const r = this.get(collection, id);
        edge("threadId", "threads", r.threadId);
        edge("parentId", "messages", r.parentId, r.threadId);
        edge(
          "editedFromMessageId",
          "messages",
          r.editedFromMessageId,
          r.threadId,
        );
        edge("generationId", "generations", r.generationId, r.threadId);
        this.write(
          "INSERT INTO archive_validation_nodes(job_id,id,parent_id,edited_id,pending) VALUES(?,?,?,?,?)",
          [
            this.jobId,
            id,
            r.parentId,
            r.editedFromMessageId,
            Number(r.parentId !== null) +
              Number(r.editedFromMessageId !== null),
          ],
        );
        break;
      }
      case "generations": {
        const r = this.get(collection, id);
        edge("threadId", "threads", r.threadId);
        edge("parentMessageId", "messages", r.parentMessageId, r.threadId);
        edge("outputMessageId", "messages", r.outputMessageId, r.threadId);
        edge("contextSnapshotId", "contexts", r.contextSnapshotId, r.threadId);
        edge("rawResponseId", "rawObjects", r.rawResponseId);
        break;
      }
      case "parts": {
        const r = this.get(collection, id);
        this.write(
          "INSERT INTO archive_validation_parts VALUES(?,?,1,?,?) ON CONFLICT(job_id,message_id) DO UPDATE SET count=count+1,first=min(first,excluded.first),last=max(last,excluded.last)",
          [this.jobId, r.messageId, r.order, r.order],
        );
        edge("messageId", "messages", r.messageId);
        if (["File", "Image", "Audio"].includes(r.kind))
          edge(
            "attachmentId",
            "attachments",
            (r as Extract<typeof r, { kind: "File" | "Image" | "Audio" }>).data
              .attachmentId,
          );
        if ((r.kind === "Text" || r.kind === "Note") && r.data.textBlob)
          this.blob(r.data.textBlob.sha256, r.data.textBlob.byteLength, true);
        if (r.kind === "ProviderArtifact")
          edge("rawObjectId", "rawObjects", r.data.rawObjectId);
        if (r.kind === "Citation")
          edge("sourcePartId", "parts", r.data.sourcePartId);
        if (r.kind === "ToolResult" && r.data.callPartId)
          edge("callPartId", "parts", r.data.callPartId);
        break;
      }
      case "events": {
        const r = this.get(collection, id);
        edge("threadId", "threads", r.threadId);
        edge("messageId", "messages", r.messageId, r.threadId);
        edge("generationId", "generations", r.generationId, r.threadId);
        break;
      }
      case "attachments": {
        const r = this.get(collection, id);
        edge("rawObjectId", "rawObjects", r.rawObjectId);
        if (r.availability === "available") {
          assert(
            r.blobSha256 !== null && r.sizeBytes !== null,
            "Available attachment lacks bytes.",
          );
          this.blob(r.blobSha256, r.sizeBytes, false);
        } else
          assert(r.blobSha256 === null, "Missing attachment claims bytes.");
        break;
      }
      case "documents": {
        const r = this.get(collection, id);
        edge("attachmentId", "attachments", r.attachmentId);
        edge("importSourceId", "importSources", r.importSourceId);
        break;
      }
      case "rawObjects": {
        const r = this.get(collection, id);
        if (r.availability === "available") {
          assert(
            r.sha256 !== null && r.byteLength !== null && r.storageRef !== null,
            "Available raw object lacks bytes.",
          );
          this.blob(r.sha256, r.byteLength, false);
        } else
          assert(
            r.sha256 === null && r.storageRef === null,
            "Missing raw object claims bytes.",
          );
        break;
      }
      case "sourceIdentities": {
        const r = this.get(collection, id);
        edge("quixiId", collections[r.entityKind], r.quixiId);
        break;
      }
      case "provenance": {
        const r = this.get(collection, id);
        edge("entityId", collections[r.entityKind], r.entityId);
        edge("importSourceId", "importSources", r.importSourceId);
        edge("rawObjectId", "rawObjects", r.rawObjectId);
        assert(
          r.locator === null || r.rawObjectId !== null,
          "Raw locator has no source.",
        );
        break;
      }
      case "tombstones": {
        const r = this.get(collection, id);
        this.write(
          "INSERT INTO archive_validation_tombstones VALUES(?,?,?,?)",
          [this.jobId, id, r.threadId, r.rootMessageId],
        );
        edge("threadId", "threads", r.threadId);
        edge("rootMessageId", "messages", r.rootMessageId, r.threadId);
        break;
      }
      case "importSources":
        break;
    }
    this.checkedEdges += expected.length;
    const actual = sqlRows(
      this.candidate,
      "SELECT field,target_collection,target_id FROM quixi_edges WHERE owner_collection=? AND owner_id=? ORDER BY field LIMIT ?",
      [collection, id, expected.length + 1],
    );
    assert(
      actual.length === expected.length,
      "Canonical edge coverage differs.",
    );
    for (const edge of expected)
      assert(
        actual.some(
          (row) =>
            row.field === edge.field &&
            row.target_collection === edge.collection &&
            row.target_id === edge.id,
        ),
        "Canonical edge target differs.",
      );
  }
  private topology(): boolean {
    if (!this.topo) {
      const node = sqlRows(
        this.scratch,
        "SELECT id FROM archive_validation_nodes WHERE job_id=? AND pending=0 AND visited=0 ORDER BY id LIMIT 1",
        [this.jobId],
      )[0];
      if (!node) {
        assert(
          !Number(
            this.scratch.selectValue(
              "SELECT EXISTS(SELECT 1 FROM archive_validation_nodes WHERE job_id=? AND visited=0)",
              [this.jobId],
            ),
          ),
          "Archive message/edit graph contains a cycle.",
        );
        return true;
      }
      this.topo = { id: String(node.id), after: "" };
      this.write(
        "UPDATE archive_validation_nodes SET visited=1 WHERE job_id=? AND id=?",
        [this.jobId, this.topo.id],
      );
    }
    const child = sqlRows(
      this.scratch,
      "SELECT id,parent_id,edited_id FROM archive_validation_nodes WHERE job_id=? AND (parent_id=? OR edited_id=?) AND id>? ORDER BY id LIMIT 1",
      [this.jobId, this.topo.id, this.topo.id, this.topo.after],
    )[0];
    if (!child) {
      this.topo = null;
      return false;
    }
    this.write(
      "UPDATE archive_validation_nodes SET pending=pending-? WHERE job_id=? AND id=?",
      [
        Number(child.parent_id === this.topo.id) +
          Number(child.edited_id === this.topo.id),
        this.jobId,
        String(child.id),
      ],
    );
    this.topo.after = String(child.id);
    return false;
  }
  private intervals(): boolean {
    const top = sqlRows(
      this.scratch,
      "SELECT depth,id,after_child FROM archive_validation_stack WHERE job_id=? ORDER BY depth DESC LIMIT 1",
      [this.jobId],
    )[0];
    if (!top) {
      const root = sqlRows(
        this.scratch,
        "SELECT id FROM archive_validation_nodes WHERE job_id=? AND parent_id IS NULL AND tin IS NULL ORDER BY id LIMIT 1",
        [this.jobId],
      )[0];
      if (!root) return true;
      this.write("INSERT INTO archive_validation_stack VALUES(?,0,?,?)", [
        this.jobId,
        String(root.id),
        "",
      ]);
      this.write(
        "UPDATE archive_validation_nodes SET tin=? WHERE job_id=? AND id=?",
        [this.clock++, this.jobId, String(root.id)],
      );
      return false;
    }
    const child = sqlRows(
      this.scratch,
      "SELECT id FROM archive_validation_nodes WHERE job_id=? AND parent_id=? AND id>? ORDER BY id LIMIT 1",
      [this.jobId, String(top.id), String(top.after_child)],
    )[0];
    if (child) {
      this.write(
        "UPDATE archive_validation_stack SET after_child=? WHERE job_id=? AND depth=?",
        [String(child.id), this.jobId, Number(top.depth)],
      );
      this.write("INSERT INTO archive_validation_stack VALUES(?,?,?,?)", [
        this.jobId,
        Number(top.depth) + 1,
        String(child.id),
        "",
      ]);
      this.write(
        "UPDATE archive_validation_nodes SET tin=? WHERE job_id=? AND id=?",
        [this.clock++, this.jobId, String(child.id)],
      );
    } else {
      this.write(
        "UPDATE archive_validation_nodes SET tout=? WHERE job_id=? AND id=?",
        [this.clock++, this.jobId, String(top.id)],
      );
      this.write(
        "DELETE FROM archive_validation_stack WHERE job_id=? AND depth=?",
        [this.jobId, Number(top.depth)],
      );
    }
    return false;
  }
  private semantics(collection: Collection, id: string) {
    switch (collection) {
      case "summaryProposals": {
        const r=this.get(collection,id),g=this.get('generations',r.generationId),source=this.get('contexts',r.sourceContextSnapshotId),request=this.get('contexts',r.requestContextSnapshotId),input=this.get('rawObjects',r.inputRawObjectId),base=contextSummary(source);
        assertSummaryCutoff(this.candidate,r.throughMessageId,r.sourceLeafMessageId);
        assert(g.purpose==='context_summary'&&g.parentMessageId===r.throughMessageId&&g.contextSnapshotId===r.requestContextSnapshotId&&r.sourceContextSnapshotId!==r.requestContextSnapshotId&&request.systemPrompt===SUMMARY_INSTRUCTION&&input.availability==='available'&&input.sha256===r.inputSha256&&input.byteLength===r.inputByteLength&&input.mediaType==='application/vnd.quixi.summary-input+json'&&r.baseSummaryProposalId===(base?.proposalId??null)&&r.baseSummaryContextId===(base?source.id:null),'Summary proposal provenance differs');
        break;
      }
      case "threads": {
        const r = this.get(collection, id),
          initial = sqlRows(
            this.candidate,
            "SELECT payload FROM quixi_records WHERE collection='contexts' AND thread_id=? AND json_extract(payload,'$.version')=1 LIMIT 2",
            [id],
          );
        assert(initial.length === 1, "Thread initial context is not unique.");
        const context = JSON.parse(String(initial[0]!.payload));
        assert(
          context.systemPrompt === r.systemPrompt &&
            encoded(context.preferredRoute) === encoded(r.preferredRoute),
          "Thread initial context differs.",
        );
        break;
      }
      case "threadStates": {
        const r = this.get(collection, id);
        assert(
          new Set(r.tags).size === r.tags.length,
          "Duplicate thread tags.",
        );
        if(r.activeLeafMessageId){const message=this.get('messages',r.activeLeafMessageId);assert(!message.generationId||!this.get('generations',message.generationId).purpose,'Summary output cannot be the selected chat branch');}
        if (r.activeLeafMessageId)
          assert(
            this.visible(r.threadId, r.activeLeafMessageId),
            "Active branch is tombstoned.",
          );
        break;
      }
      case "contexts": {
        const r = this.get(collection, id);
        assert(
          r.previousId === null
            ? r.version === 1
            : this.get("contexts", r.previousId).version === r.version - 1,
          "Context predecessor version differs.",
        );

        const summary=contextSummary(r);if(summary){const proposal=this.get('summaryProposals',summary.proposalId),generation=this.get('generations',proposal.generationId);assert(proposal.throughMessageId===summary.throughMessageId&&generation.status==='complete'&&this.get('messages',generation.outputMessageId).sealed&&summaryTextDigest(summary.reviewedText)===summary.reviewedTextSha256,'Applied summary boundary, status or exact reviewed text differs');readSummaryOutputText(this.candidate,generation,this.get('messages',generation.outputMessageId));}
        for (const partId of r.compaction?.excludedPartIds ?? []) {
          const part = this.get("parts", partId);
          assert(["Image", "File", "Audio"].includes(part.kind) && this.get("messages", part.messageId).threadId === r.threadId,
            "Context exclusions must reference attachment parts in the same thread.");
        }
        break;
      }
      case "messages": {
        const r = this.get(collection, id);
        assert(
          r.parentId !== id && r.editedFromMessageId !== id,
          "Self-referencing message.",
        );
        if(r.parentId){const parent=this.get('messages',r.parentId);assert(!parent.generationId||!this.get('generations',parent.generationId).purpose,'Summary outputs cannot be continued as ordinary chat');}
        if (r.parentId)
          assert(
            this.get("messages", r.parentId).sealed,
            "Message parent is unsealed.",
          );
        if (r.editedFromMessageId) {
          const old = this.get("messages", r.editedFromMessageId);
          assert(
            old.sealed &&
              old.parentId === r.parentId &&
              old.role === r.role &&
              r.generationId === null,
            "Invalid immutable edit.",
          );
        }
        if (r.generationId) {
          const generation = this.get("generations", r.generationId);
          assert(
            generation.outputMessageId === id &&
              generation.parentMessageId === r.parentId &&
              r.role === "assistant" &&
              r.sealed === (generation.status !== "streaming"),
            "Generation output lifecycle differs.",
          );
        } else assert(r.sealed, "Non-generation message is unsealed.");
        const parts = sqlRows(
          this.scratch,
          "SELECT count,first,last FROM archive_validation_parts WHERE job_id=? AND message_id=?",
          [this.jobId, id],
        )[0] ?? { count: 0, first: 0, last: -1 };
        assert(
          parts.count === r.partCount &&
            (!r.partCount ||
              (parts.first === 0 && parts.last === r.partCount - 1)),
          "Message part ordering/count differs.",
        );
        break;
      }
      case "generations": {
        const r = this.get(collection, id),
          parent = this.get("messages", r.parentMessageId),
          output = this.get("messages", r.outputMessageId);
        assert(
          parent.sealed &&
            output.generationId === id &&
            output.parentId === r.parentMessageId &&
            output.role === "assistant" &&
            output.sealed === (r.status !== "streaming"),
          "Generation backlinks differ.",
        );
        if(r.purpose)assert(Number(this.candidate.selectValue("SELECT count(*) FROM quixi_records WHERE collection='summaryProposals' AND generation_id=?",[r.id]))===1,'Summary generation requires exactly one proposal');
        assert(
          !(r.status === "streaming" && r.completedAt !== null) &&
            !(
              r.createdAt !== null &&
              r.completedAt !== null &&
              r.completedAt < r.createdAt
            ),
          "Generation completion time differs.",
        );
        break;
      }
      case "parts": {
        const r = this.get(collection, id),
          message = this.get("messages", r.messageId);
        assert(r.order < message.partCount, "Part is outside its message.");
        if (r.kind === "ToolResult") {
          assert(
            (r.data.callPartId === null) !==
              (r.data.unresolvedProviderCallId === null),
            "Tool result call resolution differs.",
          );
          if (r.data.callPartId) {
            const call = this.get("parts", r.data.callPartId);
            assert(
              call.kind === "ToolCall" &&
                (call.messageId === r.messageId
                  ? call.order < r.order
                  : message.parentId !== null &&
                    this.ancestor(call.messageId, message.parentId)),
              "Tool result is not after its call on the same branch.",
            );
          }
        }
        break;
      }
    }
  }
  private operation(): boolean {
    const row = sqlRows(
      this.candidate,
      "SELECT * FROM quixi_sync_ops WHERE sequence>? ORDER BY sequence LIMIT 1",
      [this.sequence],
    )[0];
    if (!row) return true;
    jsonByteLength(row, 4_194_304);
    const operationId = String(row.operation_id),
      kind = String(row.kind),
      recordedAt = Number(row.recorded_at),
      payload = JSON.parse(String(row.payload));
    assert(
      isQuixiId(operationId) &&
        Number.isSafeInteger(recordedAt) &&
        recordedAt >= 0,
      "Invalid journal operation identity.",
    );
    const operation = { version: 1, operationId, kind, recordedAt, payload };
    assert(
      row.identity === digest(operation),
      "Journal operation digest differs.",
    );
    const affects = JSON.parse(String(row.affects)) as EntityReference[];
    assert(
      Array.isArray(affects) && affects.length <= 16384,
      "Journal effects exceed their bound.",
    );
    let expected: EntityReference[] = [];
    if (kind === "ImportRecord") {
      assert(
        payload &&
          isQuixiId(payload.importId) &&
          Number.isSafeInteger(payload.ordinal) &&
          payload.ordinal >= 0 &&
          Object.hasOwn(kinds, payload.collection),
        "Invalid imported journal record.",
      );
      const collection = payload.collection as Collection;
      assert(
        collection !== "tombstones" &&
          validateEntityShape(collection, payload.record).length === 0,
        "Imported journal shape differs.",
      );
      const importJob = sqlRows(
        this.candidate,
        "SELECT thread_id,mode FROM quixi_import_jobs WHERE id=?",
        [payload.importId],
      )[0];
      assert(importJob, "Imported operation has no durable group.");
      if ("threadId" in payload.record)
        assert(
          payload.record.threadId === importJob.thread_id,
          "Imported operation crosses its declared thread.",
        );
      if (collection === "threads")
        assert(
          payload.record.id === importJob.thread_id &&
            importJob.mode === "create",
          "Imported thread scope differs.",
        );
      if (collection === "threadStates")
        assert(
          importJob.mode === "create",
          "Import extension rewrites thread state.",
        );
      if (collection === "messages")
        assert(payload.record.sealed, "Imported message is unsealed.");
      if (collection === "generations")
        assert(
          payload.record.status !== "streaming",
          "Imported attempt claims an active producer.",
        );
      const id = payload.record.id ?? payload.record.threadId;
      expected = [{ kind: kinds[collection], id }];
      const group = sqlRows(
        this.scratch,
        "SELECT next_ordinal,digest,published FROM archive_validation_imports WHERE job_id=? AND id=?",
        [this.jobId, payload.importId],
      )[0];
      assert(
        !group || group.published === 0,
        "Imported record appears after publication.",
      );
      assert(
        payload.ordinal === Number(group?.next_ordinal ?? 0),
        "Imported journal ordinal has a gap.",
      );
      this.write(
        "INSERT INTO archive_validation_imports VALUES(?,?,?,?,0) ON CONFLICT(job_id,id) DO UPDATE SET next_ordinal=excluded.next_ordinal,digest=excluded.digest",
        [
          this.jobId,
          payload.importId,
          payload.ordinal + 1,
          digest([group?.digest ?? "0".repeat(64), row.identity]),
        ],
      );
    } else if (kind === "PublishImport") {
      if (
        payload.recordCount === 0 &&
        payload.manifestDigest === "0".repeat(64)
      )
        this.write(
          "INSERT OR IGNORE INTO archive_validation_imports VALUES(?,?,0,?,0)",
          [this.jobId, payload.importId, payload.manifestDigest],
        );
      const group = sqlRows(
        this.scratch,
        "SELECT next_ordinal,digest,published FROM archive_validation_imports WHERE job_id=? AND id=?",
        [this.jobId, payload.importId],
      )[0];
      assert(
        group &&
          group.published === 0 &&
          group.next_ordinal === payload.recordCount &&
          group.digest === payload.manifestDigest,
        "Imported publication count/digest differs.",
      );
      const receipt = sqlRows(
        this.candidate,
        "SELECT state,record_count,manifest_digest,thread_id,mode,publication_operation_id FROM quixi_import_jobs WHERE id=?",
        [payload.importId],
      )[0];
      assert(
        receipt &&
          receipt.state === "published" &&
          receipt.record_count === payload.recordCount &&
          receipt.manifest_digest === payload.manifestDigest &&
          receipt.thread_id === payload.threadId &&
          receipt.mode === payload.mode &&
          receipt.publication_operation_id === operationId,
        "Published import receipt differs.",
      );
      this.write(
        "UPDATE archive_validation_imports SET published=1 WHERE job_id=? AND id=?",
        [this.jobId, payload.importId],
      );
    } else {
      assert(
        (MUTATION_KINDS as readonly string[]).includes(kind),
        "Unsupported journal operation kind.",
      );
      const history = Object.fromEntries(
        Object.keys(kinds).map((collection) => [collection, []]),
      ) as unknown as CanonicalHistory;
      history.version = 1;
      if (kind === "AppendGenerationOutput" || kind === "CompleteGeneration")
        history.generations = [this.get("generations", payload.generationId)];
      if (kind === "AttachContent") {
        const message = this.get("messages", payload.messageId);
        history.messages = [message];
        if (message.generationId)
          history.generations = [this.get("generations", message.generationId)];
      }
      expected = mutationEffects(operation as CanonicalMutation, history);
    }
    const keys = (values: EntityReference[]) =>
      values
        .map((ref) => {
          assert(
            ref && Object.hasOwn(collections, ref.kind) && isQuixiId(ref.id),
            "Invalid journal entity coverage.",
          );
          return `${ref.kind}:${ref.id}`;
        })
        .sort();
    assert(
      encoded(keys(affects)) === encoded([...new Set(keys(expected))]),
      "Journal write coverage differs.",
    );
    for (const ref of affects) {
      const collection = collections[ref.kind];
      this.get(collection, ref.id);
      this.write(
        "INSERT OR IGNORE INTO archive_validation_coverage VALUES(?,?,?)",
        [this.jobId, collection, ref.id],
      );
    }
    this.sequence = Number(row.sequence);
    assert(
      Number.isSafeInteger(this.sequence) && this.sequence > 0,
      "Invalid journal sequence.",
    );
    this.checkedOperations++;
    return false;
  }
  private receipts(): boolean {
    const row = sqlRows(
      this.candidate,
      "SELECT transaction_id,identity,result FROM quixi_transactions WHERE transaction_id>? ORDER BY transaction_id LIMIT 1",
      [this.receipt],
    )[0];
    if (!row) return this.importReceipts();
    jsonByteLength(row, 4_194_304);
    assert(
      isQuixiId(row.transaction_id) &&
        typeof row.identity === "string" &&
        /^[a-f0-9]{64}$/.test(row.identity),
      "Invalid transaction receipt identity.",
    );
    const value = JSON.parse(String(row.result));
    assert(
      value &&
        value.transactionId === row.transaction_id &&
        Array.isArray(value.operations) &&
        value.operations.length <= 128,
      "Invalid transaction receipt result.",
    );
    for (const entry of value.operations) {
      assert(
        isQuixiId(entry.operationId) &&
          ["committed", "already_committed"].includes(entry.outcome),
        "Invalid transaction operation receipt.",
      );
      const operation = sqlRows(
        this.candidate,
        "SELECT result FROM quixi_sync_ops WHERE operation_id=?",
        [entry.operationId],
      )[0];
      assert(
        operation &&
          encoded(JSON.parse(String(operation.result))) ===
            encoded(entry.result),
        "Transaction receipt refers to a different journal result.",
      );
    }
    this.receipt = String(row.transaction_id);
    return false;
  }
  private importReceipts(): boolean {
    const tables = [
      "quixi_import_jobs",
      "quixi_import_record_identities",
      "quixi_import_operations",
    ] as const;
    if (this.importTable >= tables.length) {
      assert(
        this.importedIdentities ===
          Number(
            this.scratch.selectValue(
              "SELECT coalesce(sum(next_ordinal),0) FROM archive_validation_imports WHERE job_id=?",
              [this.jobId],
            ),
          ),
        "Imported journal identity receipts are incomplete.",
      );
      return true;
    }
    const table = tables[this.importTable]!,
      key = table === "quixi_import_jobs" ? "id" : "operation_id",
      row = sqlRows(
        this.candidate,
        `SELECT * FROM ${table} WHERE ${key}>? ORDER BY ${key} LIMIT 1`,
        [this.importCursor],
      )[0];
    if (!row) {
      this.importTable++;
      this.importCursor = "";
      return false;
    }
    jsonByteLength(row, 4_194_304);
    this.importCursor = String(row[key]);
    assert(isQuixiId(this.importCursor), "Invalid import receipt identity.");
    if (table === "quixi_import_jobs") {
      const group = sqlRows(
        this.scratch,
        "SELECT next_ordinal,digest,published FROM archive_validation_imports WHERE job_id=? AND id=?",
        [this.jobId, this.importCursor],
      )[0];
      assert(
        group &&
          group.published === 1 &&
          row.state === "published" &&
          group.next_ordinal === row.record_count &&
          group.digest === row.manifest_digest,
        "Published import has no matching journal group.",
      );
      this.get("threads", String(row.thread_id));
      assert(
        sqlRows(
          this.candidate,
          "SELECT 1 FROM quixi_import_operations WHERE operation_id=? AND import_id=?",
          [String(row.publication_operation_id), this.importCursor],
        ).length,
        "Published import control receipt is absent.",
      );
    } else {
      assert(
        typeof row.identity === "string" && /^[a-f0-9]{64}$/.test(row.identity),
        "Invalid import receipt digest.",
      );
      const job = sqlRows(
        this.candidate,
        "SELECT thread_id,mode,state,publication_operation_id FROM quixi_import_jobs WHERE id=?",
        [String(row.import_id)],
      )[0];
      assert(
        job && job.state === "published",
        "Import receipt has no published owner.",
      );
      if (table === "quixi_import_record_identities") {
        const operation = sqlRows(
          this.candidate,
          "SELECT kind,identity,payload FROM quixi_sync_ops WHERE operation_id=?",
          [this.importCursor],
        )[0];
        assert(
          operation &&
            operation.kind === "ImportRecord" &&
            operation.identity === row.identity &&
            JSON.parse(String(operation.payload)).importId === row.import_id,
          "Imported identity differs from its journal operation.",
        );
        this.importedIdentities++;
      } else {
        const result = JSON.parse(String(row.result));
        assert(
          result &&
            result.importId === row.import_id &&
            result.threadId === job.thread_id &&
            result.mode === job.mode &&
            ["staging", "validating", "ready", "published"].includes(
              result.state,
            ),
          "Import control receipt result differs from its owner.",
        );
        for (const key of ["nextSequence", "recordCount", "validatedRecords"])
          assert(
            Number.isSafeInteger(result[key]) && result[key] >= 0,
            "Invalid import receipt count.",
          );
        assert(
          typeof result.manifestDigest === "string" &&
            /^[a-f0-9]{64}$/.test(result.manifestDigest),
          "Invalid import receipt manifest.",
        );
      }
    }
    return false;
  }
  /** Calls bound record/graph/receipt work units. Individual indexed SQL
   * aggregates still require separate large-archive latency qualification. */
  step(maxRecords: number): CanonicalArchiveValidationStatus {
    assert(
      Number.isSafeInteger(maxRecords) && maxRecords > 0 && maxRecords <= 128,
      "Invalid canonical validation budget.",
    );
    for (let work = 0; work < maxRecords && this.phase !== "ready"; work++) {
      if (
        this.phase === "records" ||
        this.phase === "semantics" ||
        this.phase === "coverage"
      ) {
        const row = this.nextRecord();
        if (!row) {
          this.cursor = { collection: "", id: "" };
          if (this.phase === "records") {
            assert(
              this.checkedRecords === this.manifest.source.canonicalRecords,
              "Manifest canonical record count differs.",
            );
            this.phase = "topology";
          } else if (this.phase === "semantics") this.phase = "operations";
          else this.phase = "receipts";
          continue;
        }
        assert(
          typeof row.collection === "string" &&
            Object.hasOwn(kinds, row.collection),
          "Unknown canonical collection.",
        );
        const collection = row.collection as Collection,
          id = String(row.id);
        jsonByteLength(row, 1_048_576);
        this.cursor = { collection, id };
        if (this.phase === "records") {
          const record = JSON.parse(String(row.payload));
          assert(
            validateEntityShape(collection, record).length === 0 &&
              (record.id ?? record.threadId) === id,
            "Canonical record shape/identity differs.",
          );
          this.edges(collection, id);
          this.checkedRecords++;
        } else if (this.phase === "semantics") this.semantics(collection, id);
        else
          assert(
            sqlRows(
              this.scratch,
              "SELECT 1 FROM archive_validation_coverage WHERE job_id=? AND collection=? AND id=?",
              [this.jobId, collection, id],
            ).length,
            "Canonical record has no journal coverage.",
          );
      } else if (this.phase === "topology") {
        if (this.topology()) this.phase = "intervals";
      } else if (this.phase === "intervals") {
        if (this.intervals()) this.phase = "semantics";
      } else if (this.phase === "operations") {
        if (this.operation()) {
          assert(
            this.checkedOperations === this.manifest.source.syncOperations &&
              this.sequence === this.manifest.source.highWaterSequence,
            "Manifest operation count/high-water differs.",
          );
          assert(
            !Number(
              this.scratch.selectValue(
                "SELECT EXISTS(SELECT 1 FROM archive_validation_imports WHERE job_id=? AND published=0)",
                [this.jobId],
              ),
            ),
            "Imported journal has no publication marker.",
          );
          this.phase = "coverage";
        }
      } else if (this.phase === "receipts" && this.receipts()) {
        assert(
          !this.candidate.selectValue('SELECT EXISTS(SELECT 1 FROM quixi_local_operation_claims)'),
          'Portable archives cannot contain local operation claims.',
        );
        assert(
          !sqlRows(
            this.candidate,
            "SELECT 1 FROM quixi_local_state WHERE key!='defaultWorkspaceId' LIMIT 1",
          ).length,
          "Archive contains unsupported local metadata.",
        );
        const workspace = sqlRows(
          this.candidate,
          "SELECT value FROM quixi_local_state WHERE key='defaultWorkspaceId'",
        )[0];
        assert(
          (workspace ? JSON.parse(String(workspace.value)) : null) ===
            this.manifest.source.defaultWorkspaceId,
          "Manifest default workspace differs.",
        );
        const blobs = Number(
            this.scratch.selectValue(
              "SELECT count(*) FROM archive_validation_blobs WHERE job_id=?",
              [this.jobId],
            ),
          ),
          received = Number(
            this.scratch.selectValue(
              "SELECT count(*) FROM quixi_archive_received_entries WHERE job_id=? AND path GLOB 'blobs/*'",
              [this.jobId],
            ),
          );
        // A rescue copies blob files as found, so it may carry files that no
        // canonical record references; those are removed from the candidate
        // once validation succeeds. Portable archives must match exactly.
        assert(
          (this.manifest.kind === "rescue"
            ? received >= blobs
            : blobs === received) &&
            blobs ===
              Number(
                this.candidate.selectValue(
                  "SELECT count(*) FROM quixi_blob_catalog",
                ),
              ),
          "Archive contains missing or unreferenced blobs.",
        );
        assert(
          Number(
            this.candidate.selectValue("SELECT count(*) FROM quixi_edges"),
          ) === this.checkedEdges,
          "Archive contains orphan canonical edges.",
        );
        for (const table of [
          "quixi_generation_producers",
          "quixi_import_blob_transfers",
          "quixi_import_edges",
          "quixi_import_records",
          "quixi_import_work_operations",
          "quixi_import_work",
          "quixi_import_work_groups",
          "quixi_import_allocated_ids",
          "quixi_import_runs",
          "quixi_blob_transfers",
          "quixi_blob_operations",
        ])
          assert(
            !Number(
              this.candidate.selectValue(
                `SELECT EXISTS(SELECT 1 FROM ${table})`,
              ),
            ),
            "Archive contains excluded runtime or staging data.",
          );
        assert(
          !Number(
            this.candidate.selectValue(
              "SELECT EXISTS(SELECT 1 FROM quixi_import_jobs WHERE state!='published')",
            ),
          ),
          "Archive contains unfinished imports.",
        );
        this.phase = "ready";
      }
    }
    return this.status();
  }
  blobChecks(
    after: string,
    maxItems: number,
  ): { sha256: string; byteLength: number; utf8: boolean }[] {
    assert(
      Number.isSafeInteger(maxItems) && maxItems > 0 && maxItems <= 128,
      "Invalid blob-check page.",
    );
    return sqlRows(
      this.scratch,
      "SELECT sha256,byte_length,utf8 FROM archive_validation_blobs WHERE job_id=? AND sha256>? ORDER BY sha256 LIMIT ?",
      [this.jobId, after, maxItems],
    ).map((row) => ({
      sha256: String(row.sha256),
      byteLength: Number(row.byte_length),
      utf8: row.utf8 === 1,
    }));
  }
}
