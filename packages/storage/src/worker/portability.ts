import { assertPortabilityArgs, PORTABILITY_STATUSES, type PortabilityCoverage, type PortabilityOperations, type PortabilityStatusValue } from '@quixi/core/contracts';

type Value = string | number | null;
interface PortabilitySqlite { exec(options: string | { sql: string; bind?: Value[]; rowMode?: 'object'; returnValue?: 'resultRows' }): unknown; selectValue(sql: string, bind?: Value[]): unknown }
export const PORTABILITY_STATUS_TABLE = 'quixi_portability_status';
/** Contract filter values name the product's four statuses; the stored value is the analysis status. */
export const PORTABILITY_FILTER_STATUS: Record<'fully_portable' | 'transformed' | 'provider_dependent' | 'blocked', PortabilityStatusValue> = { fully_portable: 'fully_portable', transformed: 'portable_with_transformations', provider_dependent: 'provider_dependent', blocked: 'blocked' };
/** Derived, local, non-canonical: one portability status per conversation
 * published by the application's analysis, keyed by the target set it was
 * assessed against, applied by search as an early filter. Not exported,
 * not audited as canonical, replaced whenever the target set changes. */
export class PortabilityRepository {
  constructor(private readonly db: PortabilitySqlite) {}
  initialize(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${PORTABILITY_STATUS_TABLE}(thread_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN('fully_portable','portable_with_transformations','provider_dependent','blocked','unknown')), revision INTEGER NOT NULL, targets_key TEXT NOT NULL, assessed_at INTEGER NOT NULL) STRICT`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS ${PORTABILITY_STATUS_TABLE}_status ON ${PORTABILITY_STATUS_TABLE}(status, thread_id)`);
  }
  coverage(): PortabilityCoverage {
    const latest = this.db.exec({ sql: `SELECT targets_key, max(assessed_at) AS assessed_at FROM ${PORTABILITY_STATUS_TABLE} GROUP BY targets_key ORDER BY assessed_at DESC LIMIT 1`, rowMode: 'object', returnValue: 'resultRows' }) as { targets_key: string; assessed_at: number }[];
    const byStatus = Object.fromEntries(PORTABILITY_STATUSES.map(status => [status, 0])) as Record<PortabilityStatusValue, number>;
    if (!latest.length) return { assessed: 0, targetsKey: null, assessedAt: null, byStatus };
    const key = latest[0]!.targets_key;
    for (const row of this.db.exec({ sql: `SELECT status, count(*) AS n FROM ${PORTABILITY_STATUS_TABLE} WHERE targets_key=? GROUP BY status`, bind: [key], rowMode: 'object', returnValue: 'resultRows' }) as { status: PortabilityStatusValue; n: number }[]) byStatus[row.status] = Number(row.n);
    return { assessed: Object.values(byStatus).reduce((sum, value) => sum + value, 0), targetsKey: key, assessedAt: Number(latest[0]!.assessed_at), byStatus };
  }
  record(args: PortabilityOperations['recordPortabilityAssessments']['args']): PortabilityOperations['recordPortabilityAssessments']['result'] {
    assertPortabilityArgs('recordPortabilityAssessments', args);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // A new target set starts a new analysis: earlier statuses no longer describe it.
      this.db.exec({ sql: `DELETE FROM ${PORTABILITY_STATUS_TABLE} WHERE targets_key<>?`, bind: [args.targetsKey] });
      for (const item of args.items)
        this.db.exec({ sql: `INSERT INTO ${PORTABILITY_STATUS_TABLE}(thread_id,status,revision,targets_key,assessed_at) VALUES(?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET status=excluded.status,revision=excluded.revision,targets_key=excluded.targets_key,assessed_at=excluded.assessed_at`, bind: [item.threadId, item.status, item.revision, args.targetsKey, args.assessedAt] });
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { stored: args.items.length, coverage: this.coverage() };
  }
}
