use super::models::*;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use zeroize::{Zeroize, Zeroizing};

#[derive(Serialize, Deserialize)]
struct Envelope {
    binding: Binding,
    authority: String,
    value: String,
    #[serde(default)]
    handle_id: Option<String>,
}
impl Drop for Envelope {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

/// The native actor serializes every operation, including replacement and reads.
pub struct Secrets {
    service: String,
    lock: Mutex<()>,
    pub available: bool,
}
impl Secrets {
    pub fn new(service: String) -> Self {
        #[cfg(target_os = "macos")]
        let available = match apple_native_keyring_store::keychain::Store::new() {
            Ok(store) => {
                keyring_core::set_default_store(store);
                true
            }
            Err(_) => false,
        };
        #[cfg(not(target_os = "macos"))]
        let available = false;
        Self {
            service,
            lock: Mutex::new(()),
            available,
        }
    }
    fn supported(&self, request: &str) -> Result<()> {
        if self.available {
            Ok(())
        } else {
            Err(error(
                "UNSUPPORTED",
                "OS keychain integration is unavailable on this build or the keychain could not be opened.",
                request,
            ))
        }
    }
    #[cfg(target_os = "macos")]
    fn entry(
        &self,
        handle: &SecretHandle,
        binding: &Binding,
        request: &str,
    ) -> Result<keyring_core::Entry> {
        id(&handle.id)?;
        if handle.persistence != "native" || &handle.binding != binding {
            return Err(error(
                "INVALID_REQUEST",
                "Secret handle does not match its destination/account binding.",
                request,
            ));
        }
        keyring_core::Entry::new(&self.service, &handle.id).map_err(|_| {
            error(
                "IO_ERROR",
                "Could not address the application keychain entry.",
                request,
            )
        })
    }
    #[cfg(target_os = "macos")]
    fn associated_entry(&self, binding: &Binding, request: &str) -> Result<keyring_core::Entry> {
        use sha2::{Digest, Sha256};
        let encoded = serde_json::to_vec(binding).map_err(|_| error("INTERNAL", "Could not encode credential binding.", request))?;
        let account = format!("binding-v1:{:x}", Sha256::digest(encoded));
        keyring_core::Entry::new(&self.service, &account).map_err(|_| error("IO_ERROR", "Could not address the application keychain entry.", request))
    }
    #[cfg(target_os = "macos")]
    fn read_entry(&self, entry: keyring_core::Entry, request: &str) -> Result<Envelope> {
        let bytes = Zeroizing::new(entry.get_secret().map_err(|value| match value {
            keyring_core::Error::NoEntry => error("NOT_FOUND", "Application credential is absent from the OS keychain.", request),
            _ => error("IO_ERROR", "OS keychain access failed; unlock or authorize access and reconnect.", request),
        })?);
        if bytes.len() > 32_768 { return Err(error("INVALID_REQUEST", "Keychain credential envelope exceeds its bound.", request)); }
        serde_json::from_slice(&bytes).map_err(|_| error("INVALID_REQUEST", "Application credential envelope is invalid.", request))
    }
    #[cfg(target_os = "macos")]
    fn check_envelope(&self, envelope: &Envelope, binding: &Binding, authority: Option<&str>, request: &str) -> Result<()> {
        if envelope.value.is_empty() || envelope.value.len() > 16_384 || !envelope.value.bytes().all(|byte| (32..=126).contains(&byte)) {
            return Err(error("INVALID_REQUEST", "Stored credential bytes are invalid.", request));
        }
        if &envelope.binding != binding || authority.is_some_and(|value| envelope.authority != value) {
            return Err(error("INVALID_REQUEST", "Stored credential is bound to another destination/account or credential origin.", request));
        }
        Ok(())
    }
    #[cfg(target_os = "macos")]
    fn read_unlocked(&self, handle: &SecretHandle, binding: &Binding, authority: Option<&str>, request: &str) -> Result<Envelope> {
        // Validate the handle independently even though the new item is addressed by binding.
        let legacy = self.entry(handle, binding, request)?;
        match self.read_entry(self.associated_entry(binding, request)?, request) {
            Ok(envelope) if envelope.handle_id.as_deref() == Some(handle.id.as_str()) => {
                self.check_envelope(&envelope, binding, authority, request)?;
                return Ok(envelope);
            }
            Ok(_) => (),
            Err(value) if value.code == "NOT_FOUND" => (),
            Err(value) => return Err(value),
        }
        // Existing UUID-addressed handles remain an explicit legacy path; never enumerate them.
        let envelope = self.read_entry(legacy, request)?;
        self.check_envelope(&envelope, binding, authority, request)?;
        if envelope.handle_id.is_some() { return Err(error("INVALID_REQUEST", "Legacy credential envelope is invalid.", request)); }
        Ok(envelope)
    }
    pub fn open(&self, binding: &Binding, authority: &str, request: &str) -> Result<Option<SecretHandle>> {
        self.supported(request)?;
        let _guard = self.lock.lock().map_err(|_| error("INTERNAL", "Credential actor unavailable.", request))?;
        #[cfg(target_os = "macos")]
        {
            let envelope = match self.read_entry(self.associated_entry(binding, request)?, request) {
                Ok(value) => value,
                Err(value) if value.code == "NOT_FOUND" => return Ok(None),
                Err(value) => return Err(value),
            };
            self.check_envelope(&envelope, binding, Some(authority), request)?;
            let handle_id = envelope.handle_id.as_ref().ok_or_else(|| error("INVALID_REQUEST", "Associated credential has no handle identity.", request))?;
            id(handle_id)?;
            Ok(Some(SecretHandle { id: handle_id.clone(), persistence: "native".into(), binding: binding.clone() }))
        }
        #[cfg(not(target_os = "macos"))]
        { let _ = (binding, authority); Err(error("UNSUPPORTED", "No OS keychain adapter exists for this target yet.", request)) }
    }
    pub fn read(
        &self,
        handle: &SecretHandle,
        binding: &Binding,
        authority: &str,
        request: &str,
    ) -> Result<Zeroizing<String>> {
        self.supported(request)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| error("INTERNAL", "Credential actor unavailable.", request))?;
        #[cfg(target_os = "macos")]
        {
            let mut envelope = self.read_unlocked(handle, binding, Some(authority), request)?;
            Ok(Zeroizing::new(std::mem::take(&mut envelope.value)))
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (handle, binding, authority);
            Err(error(
                "UNSUPPORTED",
                "No OS keychain adapter exists for this target yet.",
                request,
            ))
        }
    }
    pub fn put(
        &self,
        binding: Binding,
        authority: String,
        bytes: Vec<u8>,
        replace: Option<SecretHandle>,
        request: &str,
    ) -> Result<SecretHandle> {
        self.put_guarded(binding, authority, bytes, replace, request, || Ok(()))
    }
    /// OAuth's cancellation cutoff is checked under the same actor lock as
    /// replacement and deletion, immediately before the noninterruptible write.
    pub(super) fn put_guarded(
        &self,
        binding: Binding,
        authority: String,
        bytes: Vec<u8>,
        replace: Option<SecretHandle>,
        request: &str,
        before_put: impl FnOnce() -> Result<()>,
    ) -> Result<SecretHandle> {
        let bytes = Zeroizing::new(bytes);
        self.supported(request)?;
        if bytes.is_empty()
            || bytes.len() > 16_384
            || !bytes.iter().all(|byte| (32..=126).contains(byte))
        {
            return Err(error(
                "INVALID_REQUEST",
                "HTTP credentials must be bounded printable ASCII.",
                request,
            ));
        }
        let _guard = self
            .lock
            .lock()
            .map_err(|_| error("INTERNAL", "Credential actor unavailable.", request))?;
        #[cfg(target_os = "macos")]
        {
            let legacy_replace = if let Some(previous) = &replace {
                self.read_unlocked(previous, &binding, Some(&authority), request)?.handle_id.is_none()
            } else { false };
            let associated = self.associated_entry(&binding, request)?;
            match self.read_entry(self.associated_entry(&binding, request)?, request) {
                Ok(current) => {
                    self.check_envelope(&current, &binding, Some(&authority), request)?;
                    let current_id = current.handle_id.as_ref().ok_or_else(|| error("INVALID_REQUEST", "Associated credential has no handle identity.", request))?;
                    id(current_id)?;
                    if replace.as_ref().map(|handle| handle.id.as_str()) != current.handle_id.as_deref() {
                        return Err(error("CONFLICT", "Reopen the current credential before replacing it.", request));
                    }
                }
                Err(value) if value.code == "NOT_FOUND" => (),
                Err(value) => return Err(value),
            }
            let handle = SecretHandle {
                id: uuid::Uuid::new_v4().to_string(),
                persistence: "native".into(),
                binding: binding.clone(),
            };
            let envelope = Envelope {
                binding: binding.clone(),
                authority,
                handle_id: Some(handle.id.clone()),
                value: String::from_utf8(bytes.to_vec()).map_err(|_| {
                    error("INVALID_REQUEST", "Invalid credential encoding.", request)
                })?,
            };
            let serialized = Zeroizing::new(
                serde_json::to_vec(&envelope)
                    .map_err(|_| error("INTERNAL", "Could not encode credential.", request))?,
            );
            let entry = associated;
            before_put()?;
            entry.set_secret(&serialized).map_err(|_| {
                error(
                    "IO_ERROR",
                    "OS keychain rejected credential storage.",
                    request,
                )
            })?;
            if let Some(previous) = replace.filter(|_| legacy_replace) {
                if self
                    .entry(&previous, &binding, request)?
                    .delete_credential()
                    .is_err()
                {
                    let _ = entry.delete_credential();
                    return Err(error(
                        "IO_ERROR",
                        "Credential replacement failed during old-entry removal.",
                        request,
                    ));
                }
            }
            Ok(handle)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (binding, authority, replace, before_put);
            Err(error(
                "UNSUPPORTED",
                "No OS keychain adapter exists for this target yet.",
                request,
            ))
        }
    }
    pub fn delete(&self, handle: &SecretHandle, request: &str) -> Result<()> {
        self.delete_guarded(handle, request, || Ok(()))
    }
    pub(super) fn delete_guarded(&self, handle: &SecretHandle, request: &str, before_delete: impl FnOnce() -> Result<()>) -> Result<()> {
        self.supported(request)?;
        let _guard = self
            .lock
            .lock()
            .map_err(|_| error("INTERNAL", "Credential actor unavailable.", request))?;
        before_delete()?;
        #[cfg(target_os = "macos")]
        {
            let associated = match self.read_unlocked(handle, &handle.binding, None, request) {
                Ok(envelope) => envelope.handle_id.is_some(),
                Err(e) if e.code == "NOT_FOUND" => return Ok(()),
                Err(e) => return Err(e),
            };
            let entry = if associated { self.associated_entry(&handle.binding, request)? } else { self.entry(handle, &handle.binding, request)? };
            entry.delete_credential()
                .map_err(|_| {
                    error(
                        "IO_ERROR",
                        "OS keychain credential removal failed.",
                        request,
                    )
                })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = handle;
            Err(error(
                "UNSUPPORTED",
                "No OS keychain adapter exists for this target yet.",
                request,
            ))
        }
    }
    #[cfg(all(feature = "host-proof", target_os = "macos"))]
    pub fn cleanup_proof_service(&self) -> Result<()> {
        if !self.service.starts_with("ai.quixi.chat.host-proof.") {
            return Err(error(
                "INVALID_REQUEST",
                "Cleanup is restricted to the synthetic proof namespace.",
                "cleanup",
            ));
        }
        let entries = keyring_core::Entry::search(&std::collections::HashMap::from([(
            "service",
            self.service.as_str(),
        )]))
        .map_err(|_| {
            error(
                "IO_ERROR",
                "Could not enumerate the synthetic keychain namespace.",
                "cleanup",
            )
        })?;
        for entry in entries {
            entry.delete_credential().map_err(|_| {
                error(
                    "IO_ERROR",
                    "Could not clean a synthetic credential.",
                    "cleanup",
                )
            })?;
        }
        Ok(())
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    #[test]
    fn explicit_legacy_handle_migrates_to_one_reopenable_item() {
        let service = format!("ai.quixi.chat.host-proof.{}", uuid::Uuid::new_v4());
        let secrets = Secrets::new(service.clone());
        assert!(secrets.available);
        let binding = Binding { provider_id:"synthetic".into(), account_id:"primary".into(), destination_id:"synthetic-api".into(), transport_id:"native".into() };
        let request = uuid::Uuid::new_v4().to_string();
        let legacy = SecretHandle { id:uuid::Uuid::new_v4().to_string(), persistence:"native".into(), binding:binding.clone() };
        let envelope = Envelope {binding:binding.clone(),authority:"synthetic-origin".into(),value:"synthetic-legacy".into(),handle_id:None};
        let legacy_entry = secrets.entry(&legacy,&binding,&request).unwrap();
        legacy_entry.set_secret(&serde_json::to_vec(&envelope).unwrap()).unwrap();
        assert!(secrets.open(&binding,"synthetic-origin",&request).unwrap().is_none());
        assert_eq!(&*secrets.read(&legacy,&binding,"synthetic-origin",&request).unwrap(),"synthetic-legacy");
        let current = secrets.put(binding.clone(),"synthetic-origin".into(),b"synthetic-replacement".to_vec(),Some(legacy.clone()),&request).unwrap();
        assert!(legacy_entry.get_secret().is_err());
        let reopened = Secrets::new(service);
        assert_eq!(reopened.open(&binding,"synthetic-origin",&request).unwrap().unwrap().id,current.id);
        assert_eq!(reopened.open(&binding,"retargeted",&request).err().unwrap().code,"INVALID_REQUEST");
        reopened.delete(&legacy,&request).unwrap();
        assert_eq!(reopened.open(&binding,"synthetic-origin",&request).unwrap().unwrap().id,current.id);
        reopened.delete(&current,&request).unwrap();
        assert!(reopened.open(&binding,"synthetic-origin",&request).unwrap().is_none());
    }
}
