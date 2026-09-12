import { assertRoutingAliases, assertRoutingAliasArgs } from "@quixi/core/contracts";
import type { RoutingAliases, RoutingAliasOperations } from "@quixi/core/contracts";
import type { CanonicalSqlite } from "./canonical/index.ts";
import { BlobStorageError } from "./blobs.ts";

export class RoutingAliasRepository {
  constructor(private readonly db: CanonicalSqlite) {}
  read(): RoutingAliases {
    const raw = this.db.selectValue("SELECT value FROM quixi_local_state WHERE key='routingAliases'");
    if (raw === undefined || raw === null) return { version: 1, revision: 0, aliases: [] };
    try { const value: unknown = JSON.parse(String(raw)); assertRoutingAliases(value); return value; }
    catch { throw new BlobStorageError("CONFLICT", "Stored routing aliases are invalid or from an unsupported version. The stored data has been preserved."); }
  }
  write(operation: "putRoutingAlias" | "removeRoutingAlias", args: RoutingAliasOperations["putRoutingAlias"]["args"] | RoutingAliasOperations["removeRoutingAlias"]["args"]): RoutingAliases {
    assertRoutingAliasArgs(operation, args);
    const current = this.read();
    if (current.revision !== args.expectedRevision) throw new BlobStorageError("CONFLICT", "Routing aliases changed in another view. Reload aliases and reopen the editor before saving again.");
    const aliases = [...current.aliases];
    const aliasId = "alias" in args ? args.alias.id : args.aliasId;
    const index = aliases.findIndex(value => value.id === aliasId);
    if ("alias" in args) { if (index < 0) aliases.push(args.alias); else aliases[index] = args.alias; }
    else { if (index < 0) throw new BlobStorageError("NOT_FOUND", "Routing alias no longer exists"); aliases.splice(index, 1); }
    const next: RoutingAliases = { version: 1, revision: current.revision + 1, aliases };
    try { assertRoutingAliases(next); } catch (error) { throw new BlobStorageError("INVALID_REQUEST", error instanceof Error ? error.message : String(error)); }
    this.db.exec({ sql: `INSERT INTO quixi_local_state(key,value) VALUES('routingAliases',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE json_extract(quixi_local_state.value,'$.revision')=?`,
      bind: [JSON.stringify(next), args.expectedRevision] });
    if (Number(this.db.selectValue("SELECT changes()")) !== 1) throw new BlobStorageError("CONFLICT", "Routing aliases changed; reload before saving again");
    return next;
  }
}
