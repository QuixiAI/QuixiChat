# QuixiChat patch

Source: `cubecl-runtime` 0.10.0 from crates.io (MIT OR Apache-2.0).

QuixiChat changes one ownership operation in `ComputeClient::do_create`: the
method already owns each `Bytes` payload, so it moves that payload into the
scheduled write instead of allocating and copying it with `data.to_vec()`.
This is behavior-preserving for the existing descriptor and lets load-once
file-backed GGUF payloads use one host staging allocation rather than two.

The patch should be removed once the equivalent ownership fix is available in
the upstream CubeCL runtime used by Burn.
