/** Local producer liveness/fencing metadata; canonical attempts remain in records. */
export const PRODUCER_MIGRATION = { version: 6, name: 'generation_producer_fences', sql: `
CREATE TABLE quixi_generation_producers(
 generation_id TEXT PRIMARY KEY,
 producer_id TEXT NOT NULL UNIQUE,
 state TEXT NOT NULL CHECK(state IN('active','released','lost','finished'))
) STRICT;
CREATE INDEX quixi_live_producers ON quixi_generation_producers(state,generation_id);
` } as const;
