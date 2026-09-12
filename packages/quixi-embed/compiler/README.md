# Arctic model compiler

The offline compiler verifies every source artifact and the complete tensor
inventory, builds tokenizer Unicode tables against the pinned oracle, and emits
an FP32 `.qxmodel`, a tokenizer-only `.qxtokenizer`, and checksum manifests.

From the repository root, after [reference environment setup](../reference/README.md):

```sh
packages/quixi-embed/build/reference-env/bin/python packages/quixi-embed/compiler/compile_model.py
```

Normal compilation checks `format-lock.json` and cannot silently change the
runtime's expected identities. `--freeze-contract` regenerates the format lock
and C header only when deliberately reviewing a contract change. It is not a
normal build flag or a way to make a failed implementation pass.

[FORMAT.md](FORMAT.md) describes every field and ownership/error rule. The baseline
artifact is 90,785,583 bytes, SHA-256
`e1ef345cd35088b06f70c199f5a4e0311bda5983716ad6a3e7d0a604202efffc`.
The compiler is deterministic, emits zero alignment padding, and keeps downloaded
weights and generated artifacts under ignored `build/`. No generic graph is parsed
by the browser, and no unvalidated precision conversion/quantization is included.
