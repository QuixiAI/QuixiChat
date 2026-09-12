/** Dedicated-worker service entry. The owner supplies assets, executor factories,
 * private storage adapters and its RPC/producer-generation boundary.
 * Importing this module starts no worker, model download or database.
 */
export {createEmbeddingScheduler,SchedulerError,embeddingIdentityKey} from '../scheduler/scheduler.ts';
export {cpuSchedulerExecutor,gpuSchedulerExecutor,createSchedulerWithFallback} from '../scheduler/executors.ts';
export type * from '../scheduler/types.ts';
