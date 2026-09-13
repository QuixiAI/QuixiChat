import { isQuixiId } from '../model/validation.ts';

/** Product §45 portability filter (plans 07/10/12): the application's
 * portability analysis publishes one derived status per conversation to the
 * storage owner, which applies it as an early search filter. The table is
 * local and derived: it never enters a portable export, a rebuild of the
 * analysis replaces it, and a conversation without a status is simply not
 * matched by a portability filter. */
export const PORTABILITY_STATUSES = ['fully_portable', 'portable_with_transformations', 'provider_dependent', 'blocked', 'unknown'] as const;
export type PortabilityStatusValue = typeof PORTABILITY_STATUSES[number];
export const PORTABILITY_BATCH_MAX = 64;
export interface PortabilityAssessmentItem { threadId: string; status: PortabilityStatusValue; revision: number }
export interface PortabilityCoverage {
  /** Conversations with a status under the current target set. */
  assessed: number;
  targetsKey: string | null;
  assessedAt: number | null;
  byStatus: Record<PortabilityStatusValue, number>;
}
export interface PortabilityOperations {
  /** Replaces the statuses of the given conversations; a new targets key discards every earlier status first. */
  recordPortabilityAssessments: { args: { items: PortabilityAssessmentItem[]; targetsKey: string; assessedAt: number }; result: { stored: number; coverage: PortabilityCoverage } };
  portabilityCoverage: { args: null; result: PortabilityCoverage };
}
export function assertPortabilityArgs(operation: keyof PortabilityOperations, value: unknown): void {
  if (operation === 'portabilityCoverage') { if (value !== null) throw new Error('Portability coverage takes null arguments'); return; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid portability assessment arguments');
  const args = value as Record<string, unknown>;
  if (Object.keys(args).sort().join(',') !== 'assessedAt,items,targetsKey') throw new Error('Invalid portability assessment fields');
  if (typeof args.targetsKey !== 'string' || !args.targetsKey || args.targetsKey.length > 4096) throw new Error('Portability assessments need a bounded targets key');
  if (!Number.isSafeInteger(args.assessedAt) || Number(args.assessedAt) < 0) throw new Error('Portability assessments need a time');
  const items = args.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > PORTABILITY_BATCH_MAX) throw new Error(`Portability assessments carry one to ${PORTABILITY_BATCH_MAX} conversations`);
  for (const item of items as Record<string, unknown>[]) {
    if (!item || typeof item !== 'object' || Object.keys(item).sort().join(',') !== 'revision,status,threadId') throw new Error('Invalid portability assessment item');
    if (!isQuixiId(item.threadId) || !PORTABILITY_STATUSES.includes(item.status as PortabilityStatusValue) || !Number.isSafeInteger(item.revision) || Number(item.revision) < 0) throw new Error('Invalid portability assessment item');
  }
}
