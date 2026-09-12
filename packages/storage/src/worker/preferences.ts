import { normalizeLocalPreferences, assertPreferenceArgs, DEFAULT_LOCAL_PREFERENCES } from "@quixi/core/contracts";
import type { LocalPreferences, PreferenceOperations } from "@quixi/core/contracts";
import type { CanonicalSqlite } from "./canonical/index.ts";
import { BlobStorageError } from "./blobs.ts";

export class PreferenceRepository {
  constructor(private readonly db: CanonicalSqlite) {}
  read(): LocalPreferences {
    const raw = this.db.selectValue("SELECT value FROM quixi_local_state WHERE key='interactionPreferences'");
    if (raw === undefined || raw === null) return { ...DEFAULT_LOCAL_PREFERENCES };
    try {
      const value: unknown = JSON.parse(String(raw));
      return normalizeLocalPreferences(value);
    } catch {
      throw new BlobStorageError("CONFLICT", "Local preferences are invalid or from an unsupported version. Stored preferences have been preserved.");
    }
  }
  setSendKey(args: PreferenceOperations["setSendKey"]["args"]): LocalPreferences {
    assertPreferenceArgs("setSendKey", args);
    const current = this.read();
    return this.write(args.expectedRevision, { ...current, revision: current.revision + 1, sendKey: args.sendKey });
  }
  setInteractionPreferences(args: PreferenceOperations["setInteractionPreferences"]["args"]): LocalPreferences {
    assertPreferenceArgs("setInteractionPreferences", args);
    const current = this.read();
    return this.write(args.expectedRevision, { ...current, ...args.preferences, revision: current.revision + 1 });
  }
  private write(expectedRevision: number, next: LocalPreferences): LocalPreferences {
    if (next.revision !== expectedRevision + 1)
      throw new BlobStorageError("CONFLICT", "Preferences changed in another view. Reload preferences before applying your choice again.");
    // One conditional statement is atomic; the owner serializes requests. No
    // canonical operation or sync record is created for device-local metadata.
    this.db.exec({
      sql: `INSERT INTO quixi_local_state(key,value) VALUES('interactionPreferences',?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value
        WHERE json_extract(quixi_local_state.value,'$.revision')=?`,
      bind: [JSON.stringify(next), expectedRevision],
    });
    if (Number(this.db.selectValue("SELECT changes()")) !== 1)
      throw new BlobStorageError("CONFLICT", "Preferences changed in another view. Reload preferences before applying your choice again.");
    return next;
  }
}
