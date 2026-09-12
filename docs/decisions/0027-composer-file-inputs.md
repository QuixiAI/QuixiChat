# 0027 — Verified PDF files in the shared composer

Date: 2026-09-10

Status: Accepted implementation contract; validation results are recorded in
[composer files](../validation/composer-files.md).

Plans: [06](../plans/06_integrate_live_providers.md),
[08](../plans/08_build_chat_and_library_ui.md). Product sections 19, 29 and 31
require first-class files, previews and controls derived from capabilities.

## Decision

The existing OpenAI Chat Completions and Anthropic Messages adapters accept
reviewed PDF files as original base64 bytes. The catalog declares `files`, the
`file` input modality and an explicit `fileMediaTypes` list. A generic support
flag alone does not enable a format. The initial list is `application/pdf`.
Existing models and endpoints stay selected. The dated
[provider contract review](../validation/provider-file-contracts.md) records
official sources and the distinction between Chat Completions PDF inputs and
the broader Responses API file-input formats.

The composer stages bytes through HostClient and the Storage Worker, verifies
their SHA-256, and publishes an Attachment plus a canonical File content part
with the user turn. PDF preview means filename, MIME type and size; the composer
does not load arbitrary documents in an iframe. Image thumbnails continue to
use image blobs. Local names and file bytes are never used as executable code
or storage paths.

The reviewed inline request profile retains the existing 4 MiB serialized JSON
limit and bounds combined image/file raw bytes to 2.5 MiB, including historical
attachments. File and image counts are also bounded. These are application
limits, not claims about providers' maximum upload sizes. Reads check remaining
capacity before allocation; mapping checks repeated occurrences before base64
encoding. A short magic signature identifies the admitted MIME type but does
not prove that a PDF is valid, unencrypted, within the provider's page/context
limit or acceptable to the provider. Provider failures retain their normal
visible attempt outcome.

Completed staging survives a model change so users can inspect compatibility.
Pending selection/transfer is cancelled on a model change; thread/archive
changes clear staging. Cancellation fences late asynchronous results and
releases selected host handles and unpublished worker transfers.

Inspection, counting, send and regeneration share the adapter mapper. Historical
File parts load verified storage bytes and retain their original filename.
Missing or unsupported files remain File parts and produce a named refusal;
they are not silently converted to text. The existing explicit attachment
exclusion action can remove an occurrence from request context while preserving
its canonical record and bytes. Switch inspection also includes staged files.
Inspection and portability caches are invalidated when the settings controller
replaces a connection adapter, even when connection/model identifiers stay the
same. This keeps regional eligibility changes visible in the report and prevents
an earlier review from being reused for the replacement adapter.

The archive proof exposed a navigation race when the old and restored archives
contain the same conversation title. Opening the replacement client is
asynchronous, so the old library can remain visible until the new application
mounts. Library thread buttons and new-conversation controls are disabled while the selection
has changed or a replacement is opening; the navigation callback also checks
that boundary. This prevents a click from reaching the invalid old selection
and being lost when that view unmounts. The retained restored-page request trace
records the stale-selection refusal before the replacement library initialized.

## Boundaries

There is no general remote file-upload registry, Responses migration or automatic
file-to-text conversion. Other formats require their own reviewed mapping or an
explicitly reviewed transformation. The regional processing evidence currently
admits text/images only and does not automatically expand to files. The summary
proposal builder still explicitly refuses File input unless the occurrence is
excluded or another prefix is chosen; this change does not broaden its reviewed
input contract. OpenAI Chat Completions prompt counting remains unavailable.

Controlled loopback HTTP, real browser storage and archive checks establish the
local workflow and wire representation. They do not establish real provider
acceptance, document understanding, billed usage, native picker/drop behavior or
cross-host release qualification. Those gates remain named in the plans.
