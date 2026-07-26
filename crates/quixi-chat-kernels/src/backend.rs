//! Compile-time backend selection and the device policy from spec §18.
//!
//! The device is Metal. There is no `auto`, no CPU fallback, and no environment
//! variable: a silent CPU fallback on local inference is indistinguishable from
//! a hang, and a loud one is a second performance profile to support.

use serde::Serialize;

#[cfg(feature = "metal")]
pub type Backend = burn::backend::Metal;

/// The ndarray backend exists only as the parity reference in the test harness
/// (spec §21.4). It is not a runtime path and is not present in a release build.
#[cfg(feature = "test-cpu")]
pub type ReferenceBackend = burn::backend::NdArray;

/// Which backend this binary was compiled with.
#[must_use]
pub const fn name() -> &'static str {
    if cfg!(feature = "metal") {
        "metal"
    } else {
        "none"
    }
}

/// Whether the native Metal dispatch layer was compiled in.
///
/// False today: the `FusedOps` fallback is what runs, and it is what the parity
/// gates certify. Native dispatch is enabled per-op only once a recorded
/// benchmark justifies it.
#[must_use]
pub const fn native_kernels() -> bool {
    cfg!(feature = "metal-kernels")
}

#[derive(Debug, thiserror::Error)]
pub enum DeviceError {
    #[error("this binary was built without a GPU backend; rebuild with `--features metal`")]
    NotCompiled,
    #[error("no Metal device is available on this machine")]
    Unavailable,
}

/// What the health endpoint reports about the compute device.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceReport {
    pub backend: &'static str,
    pub device: String,
    pub native_kernels: bool,
}

/// The device type for the compiled backend.
#[cfg(feature = "metal")]
pub type Device = burn::tensor::Device<Backend>;

/// Resolve the compute device, failing loudly rather than degrading.
#[cfg(feature = "metal")]
pub fn device() -> Result<Device, DeviceError> {
    Ok(Device::default())
}

#[cfg(not(feature = "metal"))]
pub fn device() -> Result<(), DeviceError> {
    Err(DeviceError::NotCompiled)
}
