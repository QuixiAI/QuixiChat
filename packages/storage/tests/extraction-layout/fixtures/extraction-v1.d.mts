import type { CanonicalSqlite } from '../../../src/worker/canonical/index.ts';
import type { ExtractionRepository, ExtractionRepositoryOptions } from '../../../src/worker/extraction/index.ts';
export const ExtractionRepository: new(db: CanonicalSqlite, options: ExtractionRepositoryOptions) => Pick<ExtractionRepository,'initialize'|'execute'|'close'>;
