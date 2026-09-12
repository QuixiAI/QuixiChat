import test from 'node:test';
import { cases } from './cases.ts';
for(const entry of cases)test(entry.name,entry.run);

import { verifyCorpusGuards } from './quality.ts';
test('quality corpus evidence and negative-control annotations are well formed',()=>{verifyCorpusGuards();});
