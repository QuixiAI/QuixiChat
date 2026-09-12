#!/usr/bin/env python3
"""Build original synthetic Quixi retrieval fixtures (CC0-1.0), without user data."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TOPICS = [
 ('opfs', 'Where did we decide to use OPFS for the archive?',
  'We chose the origin private file system for the conversation archive. SQLite runs inside a dedicated worker and writes database pages through the OPFS access handle. Reloading the browser reopens that same database.',
  'The decision to reject IndexedDB concerned the canonical conversation store. We wanted SQL transactions, full text search, and one persistence path in both browser and desktop. IndexedDB can still hold unrelated browser metadata.',
  'OPFS was considered for temporary image thumbnails, but that note makes no decision about the history database.'),
 ('desktop', 'Find the discussion about a Rust desktop wrapper.',
  'The desktop application uses a small Tauri shell written in Rust. Its responsibilities are operating system privileges, keychain access, native HTTP, and file dialogs. Shared frontend code owns conversation interaction.',
  'Our wrapper discussion concluded that the Rust host should expose a narrow host interface. The browser and desktop mount the same application and start equivalent workers. We do not duplicate chat logic inside the native crate.',
  'Rust was considered for a command line image converter. That utility has no desktop window or Tauri host.'),
 ('credentials', 'How are provider API credentials stored?',
  'On desktop, provider API keys belong in the operating system keychain. Requests obtain a secret through the host adapter without copying it into history records. Exported conversation archives exclude these credentials.',
  'Browser credentials are scoped to the current session unless the user explicitly chooses supported storage. The provider transport reads the credential when sending the request. Logs redact authorization headers.',
  'Provider names and model identifiers are ordinary message metadata. They are searchable and do not contain the secret API key.'),
 ('oauth', 'Show the PDF section about OAuth redirects.',
  'Deployment handbook, page 14: OAuth callback addresses must correspond to the selected host. A redirect returns the authorization response to the application; the pending flow checks its state before exchanging the code.',
  'Deployment handbook, page 15: Register each supported callback URI with the provider. The browser callback and desktop callback can differ. A stale or unrelated redirect must not finish another sign in attempt.',
  'The PDF chapter on permanent HTTP redirects explains how moved documentation URLs are cached. It does not describe OAuth login callbacks.'),
 ('switch', 'Can I continue the same conversation after switching providers?',
  'Switching from one model vendor to another starts a new generation in the same conversation branch. The canonical messages stay intact. The adapter constructs the new request from the selected ancestry.',
  'In the provider switch discussion, we kept earlier assistant output with its original provider label. A new assistant response records the newly selected vendor and model. The history does not become a separate imported chat.',
  'Changing a provider display color updates its badge. It has no effect on which model receives the next generation.'),
 ('branch', 'What happens when an earlier user message is edited?',
  'Editing an earlier prompt creates a sibling branch with a new message. The original user text and its descendants remain available. The selected conversation view follows the new active ancestry.',
  'Regeneration and editing preserve history as a tree. A revised user prompt attaches to the original parent, and the new assistant generation attaches to the revision. Switching branches restores the other answer.',
  'Editing a thread title only changes the label in the library. It does not create a new user message or a conversation branch.'),
 ('dedup', 'Why does importing the same export twice not duplicate messages?',
  'The importer first matches provider source identifiers and fingerprints. Reimporting an unchanged export links existing canonical records rather than appending copies. The import report counts skipped duplicates.',
  'An overlapping export may add newly discovered messages while preserving source provenance for existing ones. Source identity is scoped to the provider and account so identical local IDs from unrelated exports do not collide.',
  'Two different user messages can contain the same sentence. Text equality alone must not merge their histories.'),
 ('archive', 'How can I recover my conversations from an exported archive?',
  'A portable archive contains canonical records, raw source, and referenced attachment bytes with checksums. Restore validates the manifest and content hashes before committing records. It works without contacting any model provider.',
  'The archive round trip test exports a branching conversation and its attachments, restores into an empty local database, and compares ancestry, source provenance, and every referenced blob. Derived search vectors may be rebuilt.',
  'A screenshot of the conversation is useful for sharing but cannot restore canonical branches, raw imports, or attachment bytes.'),
 ('fts', 'Does search still work when the embedding model is disabled?',
  'Full text search remains available without loading an embedding model. Semantic indexing is optional and its failure does not block lexical results, conversation reads, or imports.',
  'The search coordinator can return FTS hits while vector indexing is incomplete. It merges available rankings when semantic vectors are ready and shows coverage honestly. Rebuilding the semantic index does not clear canonical text.',
  'Disabling the search input in a mockup was a visual experiment. It is not the required behavior when the model download fails.'),
 ('pdf', 'How do we process a thousand page PDF without retaining every page?',
  'The document worker parses PDF text one page at a time. It releases page resources after extracting and normalizing bounded text spans. Downstream chunk writes use backpressure rather than accumulating the whole book.',
  'The long PDF stress test tracks peak memory while processing a thousand pages. Extraction resumes from checkpoints, and cancellation stops further page work. The UI receives progress without holding all page objects.',
  'A thousand page PDF may have a small table of contents. Measuring only that table does not establish extraction memory for the full document.'),
 ('ocr', 'When does the app ask me to run OCR on a scan?',
  'When a PDF page has little extractable text, the application can offer optional OCR. The user can run recognition or skip it. The worker rasterizes a bounded page image and indexes the recognized text.',
  'Scanned pages remain attachments even if recognition is skipped. OCR creates searchable textual passages with page provenance; it does not produce image embeddings or change the original PDF bytes.',
  'An image caption supplied by a chat provider is associated text. It is not evidence that local OCR ran on the image.'),
 ('sync', 'How are offline conversation edits synchronized later?',
  'Canonical mutations and pending sync operations commit in one local transaction. Once encrypted sync is enabled and connectivity returns, the client transfers operations and reconciles them using stable identities.',
  'Sync must tolerate retries and duplicate delivery. An operation already applied does not create another message. Local editing remains available while the service is offline, with pending status visible to the user.',
  'Embedding vectors are derived local state and are rebuilt per device. Uploading a vector cache is not the conversation sync protocol.'),
 ('recovery', 'What if I lose a device containing my encrypted archive key?',
  'Encrypted cloud backup requires an explicit recovery design. Device loss must have a documented recovery path established before users rely on backup. The service stores ciphertext and cannot silently invent a missing decryption secret.',
  'The recovery flow verifies that the user can restore encrypted history from the supported recovery material. A device revocation stops future access as specified by the key lifecycle, and the UI distinguishes backup from guaranteed recoverability.',
  'Resetting a website password restores account login. It does not automatically decrypt a backup encrypted with an unrelated lost key.'),
 ('priority', 'Can an interactive search interrupt background embedding work?',
  'The inference scheduler gives interactive query embeddings priority over archive backfill. Queued background batches yield between bounded executions so a new search does not wait behind the entire import.',
  'Backfill admission has separate request and token limits. Query priority changes which batch runs next; it does not terminate a GPU dispatch in the middle of a kernel. Cancellation discards unneeded results and releases queued work.',
  'A progress bar animation has its own rendering priority. It does not change inference queue order.'),
 ('cache', 'Why is transformer prefix caching invalid for this encoder?',
  'The text encoder attends bidirectionally. Appending words can change hidden states for earlier tokens, so a cached transformer prefix cannot be reused as if this were autoregressive decoding.',
  'Cache complete embeddings using the model identity, role semantics, and exact token sequence. Repeated documents can share final results, but partial prefix states are not reusable because every token can attend to later tokens.',
  'Tokenization of repeated strings can be cached independently. This does not authorize reusing transformer attention states for a shared prefix.'),
 ('sql', 'Show the code example for an atomic canonical write and sync operation.',
  'BEGIN IMMEDIATE;\nINSERT INTO messages(id, text) VALUES (:id, :text);\nINSERT INTO sync_operations(id, entity_id) VALUES (:op, :id);\nCOMMIT;\nThe worker rolls back the whole transaction if either insert fails.',
  'The transaction example keeps the user message and its outgoing operation together. After crash recovery, both rows exist or neither does. Sending the network operation occurs after the local commit.',
  'SELECT text FROM messages ORDER BY created_at LIMIT 20; is a read query. It does not atomically append a message and sync operation.'),
 ('rrf', 'How do lexical and semantic result lists get combined?',
  'Reciprocal rank fusion combines ranked result lists rather than treating their raw scores as comparable. A hit appearing near the top of both lexical and semantic searches receives contributions from both ranks.',
  'RRF uses a constant plus each one based rank in the denominator. The coordinator deduplicates hits by stable chunk identity, adds rank contributions, and retains provenance so the reader can open the source passage.',
  'Sorting provider models alphabetically is a ranking operation for a settings menu. It is unrelated to combining search results.'),
 ('accessibility', 'How should streaming responses be announced to a screen reader?',
  'Streaming accessibility uses controlled live announcements so every token does not interrupt the reader. The interface preserves keyboard focus and exposes generation state in text as well as visual indicators.',
  'The accessibility review checks keyboard navigation, visible focus, scalable text, reduced motion, and screen reader semantics. A completed answer can be announced without repeatedly reading the full growing response.',
  'Increasing a token streaming buffer may improve transport efficiency. It does not by itself provide accessible live region announcements.'),
]


def build():
    documents, queries, qrels = [], [], {}
    for topic, query, positive, second, negative in TOPICS:
        kind = 'document' if topic == 'oauth' else 'code' if topic == 'sql' else 'conversation'
        for suffix, text in [('a', positive), ('b', second), ('near', negative)]:
            documents.append({'id': f'{topic}-{suffix}', 'kind': kind, 'text': text,
                              'source': 'original synthetic fixture; no user history'})
        queries.append({'id': topic, 'text': query})
        qrels[topic] = {f'{topic}-a': 2, f'{topic}-b': 1}
    # One genuinely long assistant answer: relevant facts occur after the first
    # 512 model tokens, testing the passage chunker rather than truncation alone.
    preamble = ('Before selecting a storage approach, the team reviewed application packaging, '
                'the sidebar layout, download progress, offline navigation, and common support questions. ')
    long_text = preamble * 30 + '\n\n' + TOPICS[0][2] + '\n\n' + TOPICS[0][3]
    documents.append({'id': 'opfs-long', 'kind': 'assistant-answer', 'text': long_text,
                      'source': 'original synthetic fixture; no user history'})
    qrels['opfs']['opfs-long'] = 2
    # >500 unique distractors make the coarse candidate sizes nontrivial. These
    # have repeated templates and are explicitly a smoke corpus, not a population sample.
    subjects = ['garden watering', 'bread baking', 'train schedules', 'office lighting',
                'camera lenses', 'museum tickets', 'bicycle repairs', 'weather observations',
                'music rehearsals', 'camping equipment', 'house plants', 'ceramic glazing']
    for i in range(600):
        subject = subjects[i % len(subjects)]
        documents.append({'id': f'distractor-{i:04d}', 'kind': 'conversation',
                          'text': f'Notebook entry {i}: We discussed {subject}. The comparison covered option {i % 17}, '
                                  f'a budget of {20 + i} units, and a follow up on day {1 + i % 28}. '
                                  f'The group selected sample {i % 31} and recorded the observed result in table {i}.',
                          'source': 'original generated distractor; deterministic template'})
    ROOT.mkdir(parents=True, exist_ok=True)
    (ROOT / 'corpus.jsonl').write_text(''.join(json.dumps(d, ensure_ascii=False) + '\n' for d in documents))
    for name, value in [('queries.json', queries), ('qrels.json', qrels)]:
        (ROOT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    manifest = {'version': 'quixi-synthetic-v1', 'license': 'CC0-1.0', 'documents': len(documents),
                'queries': len(queries), 'judgment_policy': 'Authored before scoring; grades 1 and 2 both count as relevant.',
                'limitations': ['English-focused synthetic smoke corpus', 'Template distractors',
                               'Not sufficient to approve compression or claim general relevance'],
                'files': {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                          for name in ['corpus.jsonl', 'queries.json', 'qrels.json']}}
    (ROOT / 'corpus-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(f'Built {len(documents)} original documents and {len(queries)} judged queries.')


if __name__ == '__main__':
    build()
