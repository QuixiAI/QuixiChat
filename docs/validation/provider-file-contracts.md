# Reviewed provider PDF input contracts

Reviewed 2026-09-10. This is a protocol review plus synthetic validation, not a
successful live-provider PDF request. Existing models and endpoints stay fixed.

| Connection | Reviewed request mapping | Evidence |
| --- | --- | --- |
| `gpt-4.1-mini-2025-04-14`, `/v1/chat/completions` | User content block `type: "file"`, with `file.filename` and `file.file_data` containing a `data:application/pdf;base64,` URL. | The [OpenAI file-input guide](https://developers.openai.com/api/docs/guides/file-inputs) has an explicit Chat Completions base64 PDF example. The [GPT-4.1 mini model page](https://developers.openai.com/api/docs/models/gpt-4.1-mini) confirms image input and the unchanged snapshot. |
| `claude-haiku-4-5-20251001`, `/v1/messages` | User block `type: "document"`, `source: {type: "base64", media_type: "application/pdf", data}` and `title` from filename. | [Claude PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support) documents this source and active-model support; the [official SDK's DocumentBlockParam](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts) includes optional `title`. |

The OpenAI guide requires vision support for PDF text/page-image processing and
states a 50 MB combined file limit, with each individual file under 50 MB. The
reviewed page does not establish a PDF page-count or encryption acceptance rule.
Its broader file-type list does not establish equivalent Chat Completions support
for DOCX, spreadsheets or text files; this adapter enables PDF only. These are
review conclusions from the [file-input guide](https://developers.openai.com/api/docs/guides/file-inputs).

Claude documents a 32 MB request limit and 100 pages across the request for
contexts below one million tokens, which includes this catalog's 200,000-token
Haiku profile. Standard PDFs must not be password-protected or encrypted. Dense
pages may exhaust context sooner. Claude also documents counting PDFs through its
token-count endpoint. These constraints come from [PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support).

Quixi deliberately applies smaller bounds: 2,621,440 raw bytes per PDF and across
all image/file occurrences in the request, at most 20 PDFs and 20 images, and the
existing 4 MiB encoded JSON ceiling. Repeated references count each time their
bytes would be sent. The mapper checks the remaining raw budget before base64
allocation. Stream setup snapshots the bounded prepared request, rather than
cloning unvalidated or unused caller attachment buffers.

`files: supported` and the `file` input modality alone are insufficient: a model
must also declare the exact MIME type in `fileMediaTypes`. Missing metadata,
unsupported MIME/role, absent or empty verified bytes, excessive size/count and
invalid filenames produce explicit compatibility refusals. Filename metadata is
bounded to 255 characters, cannot contain path separators or ASCII C0 controls,
and defaults to `attachment.pdf` only when omitted. It is never used as a local
path; Unicode and leading whitespace are preserved.

Analysis, preparation and counting share the same mapper. Anthropic's explicit
count sends the same document blocks with generation-only fields removed;
OpenAI counting remains unavailable. Files are not converted into canonical text.
Checksum verification and a staging PDF signature sniff do not establish valid
PDF structure, page count, lack of encryption or provider acceptance. This slice
does not add a PDF parser, extraction service, uploaded provider-file lifecycle,
or automatic splitting.

Existing regional processing evidence remains limited to text and images. A
PDF-bearing regional request must therefore be refused before count/send rather
than infer regional file coverage from general model PDF support. No regional
metadata or registered destination is broadened in this increment. The settings
controller intersects effective input modalities with the admitted regional
evidence, removes file MIME support when absent, and applies image confirmation
separately. Its controller test checks actual adapters for both native and relay
US/EU routes, with image confirmation on and off: PDF analysis, prepare, count and
stream refuse before body staging or HTTP.

Validation: `npm run test --workspace @quixi/providers` passes 51 tests, including
nine PDF groups covering exact decoded bytes for both protocols, explicit
refusals, aggregate allocation, retained JSON limit, real loopback count/generation
requests, caller-mutation isolation and zero dispatch on incompatible files.
