//! Opaque native file grants and bounded disk-backed export staging.
use super::{Session, models::*};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
};
use tauri::WebviewWindow;
use tauri_plugin_dialog::DialogExt;
use tokio_util::sync::CancellationToken;
const MAX_DISK_BYTES: u64 = 1 << 40; // Host-owned 1 TiB retained staging budget; physical quota also applies.
const MAX_TRANSFERS: usize = 16;
struct DiskState {
    file: File,
    size: u64,
    sequence: u32,
    final_chunk: bool,
    verified: bool,
    hasher: Sha256,
    expected_bytes: Option<u64>,
    expected_hash: Option<String>,
}
struct DiskStage {
    owner: String,
    request: String,
    cancelled: AtomicBool,
    state: Mutex<DiskState>,
    budget: Arc<AtomicU64>,
}
impl Drop for DiskStage {
    fn drop(&mut self) {
        self.budget.fetch_sub(
            self.state.get_mut().expect("file stage poisoned").size,
            Ordering::SeqCst,
        );
    }
}
struct Grant {
    owner: String,
    file: Arc<File>,
    size: u64,
    modified: Option<std::time::SystemTime>,
}
struct FileSource {
    owner: String,
    request: String,
    file_id: String,
    file: Arc<File>,
    size: u64,
    modified: Option<std::time::SystemTime>,
    offset: u64,
    sequence: u32,
    pending: BTreeMap<u32, u64>,
    final_chunk: bool,
}
struct FileOperation {
    owner: String,
    token: CancellationToken,
    state: Mutex<(bool, bool)>,
} // committing, complete
pub struct Files {
    stages: Mutex<HashMap<String, Arc<DiskStage>>>,
    grants: Mutex<HashMap<String, Grant>>,
    sources: Mutex<HashMap<String, Arc<Mutex<FileSource>>>>,
    operations: Mutex<HashMap<String, Arc<FileOperation>>>,
    budget: Arc<AtomicU64>,
    io: Arc<tokio::sync::Semaphore>,
    dialogs: Arc<tokio::sync::Semaphore>,
}
fn io_error(value: std::io::Error, request: &str) -> HostError {
    if value.kind() == std::io::ErrorKind::StorageFull {
        error(
            "QUOTA_EXCEEDED",
            "Insufficient disk space for the native file transfer.",
            request,
        )
    } else {
        error(
            "IO_ERROR",
            "Native file operation failed; check access, available space and destination availability.",
            request,
        )
    }
}
fn transfer(id: &str) -> Value {
    json!({"transferId":id,"maxChunkBytes":CHUNK_BYTES,"maxInFlight":IN_FLIGHT})
}
fn check_session(session: &Session, request: &str) -> Result<()> {
    if session.closed.load(Ordering::SeqCst) {
        Err(error("CLOSED", "Native file session is closed.", request))
    } else {
        Ok(())
    }
}
fn check_operation(op: &FileOperation, request: &str) -> Result<()> {
    if op.token.is_cancelled() {
        Err(error(
            "CANCELLED",
            "Native file operation cancelled before commit.",
            request,
        ))
    } else {
        Ok(())
    }
}
#[cfg(unix)]
fn read_at(file: &File, bytes: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::unix::fs::FileExt;
    file.read_at(bytes, offset)
}
#[cfg(windows)]
fn read_at(file: &File, bytes: &mut [u8], offset: u64) -> std::io::Result<usize> {
    use std::os::windows::fs::FileExt;
    file.seek_read(bytes, offset)
}
impl Files {
    pub fn new() -> Self {
        Self {
            stages: Mutex::new(HashMap::new()),
            grants: Mutex::new(HashMap::new()),
            sources: Mutex::new(HashMap::new()),
            operations: Mutex::new(HashMap::new()),
            budget: Arc::new(AtomicU64::new(0)),
            io: Arc::new(tokio::sync::Semaphore::new(4)),
            dialogs: Arc::new(tokio::sync::Semaphore::new(1)),
        }
    }
    async fn run<T: Send + 'static>(
        self: &Arc<Self>,
        request: &str,
        work: impl FnOnce(Arc<Self>) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let permit = self.io.clone().try_acquire_owned().map_err(|_| {
            error(
                "OVERLOADED",
                "Native file IO admission limit reached.",
                request,
            )
        })?;
        let files = self.clone();
        let request = request.to_string();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work(files)
        })
        .await
        .map_err(|_| error("INTERNAL", "Native file actor failed.", &request))?
    }
    pub fn has_stage(&self, owner: &str, id: &str) -> bool {
        self.stages
            .lock()
            .expect("stages poisoned")
            .get(id)
            .is_some_and(|stage| stage.owner == owner)
    }
    pub fn has_source(&self, owner: &str, id: &str) -> bool {
        self.sources
            .lock()
            .expect("sources poisoned")
            .get(id)
            .is_some_and(|source| source.lock().expect("source poisoned").owner == owner)
    }
    fn stage(&self, owner: &str, id: &str) -> Result<Arc<DiskStage>> {
        self.stages
            .lock()
            .expect("stages poisoned")
            .get(id)
            .filter(|stage| stage.owner == owner && !stage.cancelled.load(Ordering::SeqCst))
            .cloned()
            .ok_or_else(|| {
                error(
                    "NOT_FOUND",
                    "Disk transfer is absent or belongs to another session.",
                    id,
                )
            })
    }
    pub async fn begin(
        self: &Arc<Self>,
        session: Arc<Session>,
        request: String,
        expected_bytes: Option<u64>,
        expected_hash: Option<String>,
    ) -> Result<Value> {
        let rid = request.clone();
        self.run(&rid, move |files| {
            check_session(&session, &request)?;
            if expected_bytes.is_some_and(|size| size > MAX_DISK_BYTES) {
                return Err(error(
                    "QUOTA_EXCEEDED",
                    "Native disk staging exceeds its 1 TiB host budget.",
                    &request,
                ));
            }
            let mut stages = files.stages.lock().expect("stages poisoned");
            if stages.len() >= MAX_TRANSFERS {
                return Err(error(
                    "OVERLOADED",
                    "Native disk staging transfer limit reached.",
                    &request,
                ));
            }
            let file = tempfile::tempfile().map_err(|e| io_error(e, &request))?;
            check_session(&session, &request)?;
            let id = uuid::Uuid::new_v4().to_string();
            stages.insert(
                id.clone(),
                Arc::new(DiskStage {
                    owner: session.id.clone(),
                    request,
                    cancelled: AtomicBool::new(false),
                    budget: files.budget.clone(),
                    state: Mutex::new(DiskState {
                        file,
                        size: 0,
                        sequence: 0,
                        final_chunk: false,
                        verified: false,
                        hasher: Sha256::new(),
                        expected_bytes,
                        expected_hash,
                    }),
                }),
            );
            Ok(json!({"transferId":id,"maxChunkBytes":CHUNK_BYTES,"maxInFlight":1}))
        })
        .await
    }
    pub async fn write(
        self: &Arc<Self>,
        owner: String,
        id: String,
        sequence: u32,
        offset: u64,
        final_chunk: bool,
        bytes: Vec<u8>,
    ) -> Result<Value> {
        let rid = id.clone();
        self.run(&rid, move |files| {
            let stage = files.stage(&owner, &id)?;
            let mut state = stage
                .state
                .try_lock()
                .map_err(|_| error("CONFLICT", "Disk transfer already has pending IO.", &id))?;
            let end = state
                .size
                .checked_add(bytes.len() as u64)
                .filter(|end| *end <= MAX_DISK_BYTES)
                .ok_or_else(|| {
                    error(
                        "QUOTA_EXCEEDED",
                        "Native file staging budget exceeded.",
                        &id,
                    )
                })?;
            if state.sequence != sequence
                || state.size != offset
                || state.final_chunk
                || state.verified
                || bytes.len() > CHUNK_BYTES
                || bytes.is_empty() && !final_chunk
                || state.expected_bytes.is_some_and(|size| end > size)
            {
                return Err(error(
                    "INVALID_REQUEST",
                    "Invalid disk chunk sequence, offset or size.",
                    &id,
                ));
            }
            files
                .budget
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
                    current
                        .checked_add(bytes.len() as u64)
                        .filter(|next| *next <= MAX_DISK_BYTES)
                })
                .map_err(|_| {
                    error(
                        "QUOTA_EXCEEDED",
                        "Native retained disk staging budget exceeded.",
                        &id,
                    )
                })?;
            if let Err(e) = state.file.write_all(&bytes) {
                files.budget.fetch_sub(bytes.len() as u64, Ordering::SeqCst);
                stage.cancelled.store(true, Ordering::SeqCst);
                drop(state);
                files.release(&owner, &id);
                return Err(io_error(e, &id));
            }
            state.hasher.update(&bytes);
            state.size = end;
            state.sequence += 1;
            state.final_chunk = final_chunk;
            if stage.cancelled.load(Ordering::SeqCst) {
                return Err(error(
                    "CANCELLED",
                    "Disk transfer was released during IO.",
                    &id,
                ));
            }
            Ok(json!({"transferId":id,"sequence":sequence,"committedOffset":end}))
        })
        .await
    }
    pub async fn finish(
        self: &Arc<Self>,
        owner: String,
        id: String,
        request: String,
        size: u64,
        hash: String,
    ) -> Result<Value> {
        let rid = request.clone();
        self.run(&rid, move |files| {
            let stage = files.stage(&owner, &id)?;
            let mut state = stage.state.try_lock().map_err(|_| {
                error(
                    "CONFLICT",
                    "Disk transfer already has pending IO.",
                    &request,
                )
            })?;
            let digest = format!("{:x}", state.hasher.clone().finalize());
            if !state.final_chunk
                || state.size != size
                || state
                    .expected_bytes
                    .is_some_and(|expected| expected != size)
                || digest != hash
                || state
                    .expected_hash
                    .as_ref()
                    .is_some_and(|expected| expected != &hash)
            {
                return Err(error(
                    "INVALID_REQUEST",
                    "Disk transfer length or SHA-256 does not match.",
                    &request,
                ));
            }
            state.file.sync_all().map_err(|e| io_error(e, &request))?;
            state.verified = true;
            Ok(json!({"transferId":id,"byteLength":size,"sha256":digest,"state":"verified_staged"}))
        })
        .await
    }
    pub fn release(&self, owner: &str, id: &str) {
        let mut stages = self.stages.lock().expect("stages poisoned");
        if stages.get(id).is_some_and(|stage| stage.owner == owner) {
            if let Some(stage) = stages.remove(id) {
                stage.cancelled.store(true, Ordering::SeqCst);
            }
        }
        drop(stages);
        self.sources
            .lock()
            .expect("sources poisoned")
            .retain(|key, source| {
                key != id || source.lock().expect("source poisoned").owner != owner
            });
    }
    fn operation(&self, owner: &str, request: &str) -> Result<Arc<FileOperation>> {
        let mut operations = self.operations.lock().expect("file operations poisoned");
        if operations.contains_key(request) {
            return Err(error(
                "CONFLICT",
                "File request ID has already been used.",
                request,
            ));
        }
        if operations.len() >= 64 {
            operations.retain(|_, op| !op.state.lock().expect("file operation poisoned").1);
        }
        if operations.len() >= 64 {
            return Err(error(
                "OVERLOADED",
                "Native file operation limit reached.",
                request,
            ));
        }
        let op = Arc::new(FileOperation {
            owner: owner.into(),
            token: CancellationToken::new(),
            state: Mutex::new((false, false)),
        });
        operations.insert(request.into(), op.clone());
        Ok(op)
    }
    pub fn cancel(&self, owner: &str, request: &str) -> Option<Value> {
        let operation = self
            .operations
            .lock()
            .expect("operations poisoned")
            .get(request)
            .filter(|op| op.owner == owner)
            .cloned();
        let mut known = false;
        let mut committing = false;
        let mut complete = false;
        if let Some(op) = operation {
            known = true;
            let state = op.state.lock().expect("operation poisoned");
            committing = state.0;
            complete = state.1;
            op.token.cancel();
        }
        self.stages
            .lock()
            .expect("stages poisoned")
            .retain(|_, stage| {
                let remove = stage.owner == owner && stage.request == request;
                if remove {
                    known = true;
                    stage.cancelled.store(true, Ordering::SeqCst);
                }
                !remove
            });
        self.sources
            .lock()
            .expect("sources poisoned")
            .retain(|_, source| {
                let source = source.lock().expect("source poisoned");
                let remove = source.owner == owner && source.request == request;
                known |= remove;
                !remove
            });
        known.then(||json!({"requestId":request,"outcome":if complete {"already_completed"} else if committing {"unknown_outcome"} else {"cancelled"},"externalEffect":if committing {"may_have_occurred"}else{"not_dispatched"}}))
    }
    pub fn close(&self, owner: &str) {
        for op in self
            .operations
            .lock()
            .expect("operations poisoned")
            .values()
            .filter(|op| op.owner == owner)
        {
            op.token.cancel();
        }
        self.stages
            .lock()
            .expect("stages poisoned")
            .retain(|_, stage| {
                if stage.owner == owner {
                    stage.cancelled.store(true, Ordering::SeqCst);
                    false
                } else {
                    true
                }
            });
        self.sources
            .lock()
            .expect("sources poisoned")
            .retain(|_, source| source.lock().expect("source poisoned").owner != owner);
        self.grants
            .lock()
            .expect("grants poisoned")
            .retain(|_, grant| grant.owner != owner);
    }
    async fn pick(
        self: &Arc<Self>,
        window: WebviewWindow,
        operation: Arc<FileOperation>,
        request: &str,
        multiple: bool,
        name: Option<String>,
        extensions: Vec<String>,
    ) -> Result<Vec<PathBuf>> {
        check_operation(&operation, request)?;
        #[cfg(feature = "host-proof")]
        if let Some(paths) = crate::host_proof::file_selection(name.as_deref()) {
            return paths.map_err(|_| {
                error(
                    "INVALID_REQUEST",
                    "Invalid synthetic file proof selection.",
                    request,
                )
            });
        }
        let permit = self.dialogs.clone().try_acquire_owned().map_err(|_| {
            error(
                "OVERLOADED",
                "Close the existing native file dialog first.",
                request,
            )
        })?;
        let (send, receive) = tokio::sync::oneshot::channel();
        let mut dialog = window.dialog().file().set_parent(&window);
        if !extensions.is_empty() {
            dialog = dialog.add_filter(
                "Requested file types",
                &extensions.iter().map(String::as_str).collect::<Vec<_>>(),
            );
        }
        if let Some(name) = name {
            dialog.set_file_name(name).save_file(move |path| {
                let _permit = permit;
                let _ = send.send(path.into_iter().collect::<Vec<_>>());
            });
        } else if multiple {
            dialog.pick_files(move |paths| {
                let _permit = permit;
                let _ = send.send(paths.unwrap_or_default());
            });
        } else {
            dialog.pick_file(move |path| {
                let _permit = permit;
                let _ = send.send(path.into_iter().collect::<Vec<_>>());
            });
        }
        let paths = tokio::select! { _=operation.token.cancelled()=>return Err(error("CANCELLED","Native file dialog operation cancelled; close its panel to dismiss it.",request)), paths=receive=>paths.map_err(|_|error("IO_ERROR","Native file dialog did not return a selection.",request))? };
        check_operation(&operation, request)?;
        paths
            .into_iter()
            .map(|path| {
                path.into_path().map_err(|_| {
                    error(
                        "UNSUPPORTED",
                        "This platform returned a non-filesystem file selection.",
                        request,
                    )
                })
            })
            .collect()
    }
    pub async fn choose(
        self: &Arc<Self>,
        window: WebviewWindow,
        session: Arc<Session>,
        request: String,
        multiple: bool,
        media_types: Vec<String>,
    ) -> Result<Value> {
        let extensions = extensions(&media_types, &request)?;
        check_session(&session, &request)?;
        let op = self.operation(&session.id, &request)?;
        if let Err(error) = check_session(&session, &request) {
            op.token.cancel();
            op.state.lock().expect("operation poisoned").1 = true;
            return Err(error);
        }
        let result = async {
            let paths = self
                .pick(window, op.clone(), &request, multiple, None, extensions)
                .await?;
            let rid = request.clone();
            let op = op.clone();
            self.run(&rid, move |files| {
                check_operation(&op, &request)?;
                files.grant(&session, &request, paths)
            })
            .await
        }
        .await;
        op.state.lock().expect("operation poisoned").1 = true;
        result
    }
    fn grant(&self, session: &Session, request: &str, paths: Vec<PathBuf>) -> Result<Value> {
        check_session(session, request)?;
        let mut grants = self.grants.lock().expect("grants poisoned");
        if paths.len() > 256 || grants.len() + paths.len() > 256 {
            return Err(error(
                "OVERLOADED",
                "Release selected file handles before selecting more files.",
                request,
            ));
        }
        let mut pending = Vec::new();
        let mut output = Vec::new();
        for path in paths {
            let file = File::open(&path).map_err(|e| io_error(e, request))?;
            let metadata = file.metadata().map_err(|e| io_error(e, request))?;
            if !metadata.is_file() || metadata.len() > 9_007_199_254_740_991 {
                return Err(error(
                    "INVALID_REQUEST",
                    "Native imports require regular files with a safe byte length.",
                    request,
                ));
            }
            let id = uuid::Uuid::new_v4().to_string();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| {
                    error(
                        "UNSUPPORTED",
                        "Selected filename cannot be represented as text.",
                        request,
                    )
                })?;
            output.push(json!({"id":id,"name":name,"mediaType":null,"byteLength":metadata.len()}));
            pending.push((
                id,
                Grant {
                    owner: session.id.clone(),
                    file: Arc::new(file),
                    size: metadata.len(),
                    modified: metadata.modified().ok(),
                },
            ));
        }
        check_session(session, request)?;
        grants.extend(pending);
        Ok(json!(output))
    }
    pub fn open(&self, session: &Session, request: &str, file_id: &str) -> Result<Value> {
        let grants = self.grants.lock().expect("grants poisoned");
        let grant = grants
            .get(file_id)
            .filter(|grant| grant.owner == session.id)
            .ok_or_else(|| {
                error(
                    "NOT_FOUND",
                    "Selected file handle is absent or belongs to another session.",
                    request,
                )
            })?;
        let mut sources = self.sources.lock().expect("sources poisoned");
        check_session(session, request)?;
        if sources.len() >= MAX_TRANSFERS {
            return Err(error(
                "OVERLOADED",
                "Native file reader limit reached.",
                request,
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        sources.insert(
            id.clone(),
            Arc::new(Mutex::new(FileSource {
                owner: session.id.clone(),
                request: request.into(),
                file_id: file_id.into(),
                file: grant.file.clone(),
                size: grant.size,
                modified: grant.modified,
                offset: 0,
                sequence: 0,
                pending: BTreeMap::new(),
                final_chunk: false,
            })),
        );
        Ok(transfer(&id))
    }
    pub fn release_file(&self, owner: &str, id: &str) {
        self.grants
            .lock()
            .expect("grants poisoned")
            .retain(|key, grant| key != id || grant.owner != owner);
        self.sources
            .lock()
            .expect("sources poisoned")
            .retain(|_, source| {
                let source = source.lock().expect("source poisoned");
                source.owner != owner || source.file_id != id
            });
    }
    pub async fn read(self: &Arc<Self>, owner: String, id: String) -> Result<Vec<u8>> {
        let rid = id.clone();
        self.run(&rid, move |files| {
            let source = files
                .sources
                .lock()
                .expect("sources poisoned")
                .get(&id)
                .cloned()
                .ok_or_else(|| error("NOT_FOUND", "Native file reader is absent.", &id))?;
            let mut source = source
                .try_lock()
                .map_err(|_| error("CONFLICT", "Native file read already pending.", &id))?;
            if source.owner != owner {
                return Err(error(
                    "NOT_FOUND",
                    "Native file reader belongs to another session.",
                    &id,
                ));
            }
            if source.final_chunk {
                return Err(error(
                    "CONFLICT",
                    "Native file reader already reached EOF.",
                    &id,
                ));
            }
            if source.pending.len() >= IN_FLIGHT {
                return Err(error(
                    "OVERLOADED",
                    "Acknowledge a native file chunk before reading more.",
                    &id,
                ));
            }
            let metadata = source.file.metadata().map_err(|e| io_error(e, &id))?;
            if metadata.len() != source.size || metadata.modified().ok() != source.modified {
                return Err(error(
                    "CONFLICT",
                    "Selected file changed during import; select it again.",
                    &id,
                ));
            }
            let mut bytes = vec![0; CHUNK_BYTES.min((source.size - source.offset) as usize)];
            let count =
                read_at(&source.file, &mut bytes, source.offset).map_err(|e| io_error(e, &id))?;
            bytes.truncate(count);
            if count == 0 && source.offset < source.size {
                return Err(error(
                    "IO_ERROR",
                    "Selected file ended before its declared length.",
                    &id,
                ));
            }
            let offset = source.offset;
            let sequence = source.sequence;
            source.offset += count as u64;
            source.sequence = source.sequence.checked_add(1).ok_or_else(|| {
                error(
                    "INVALID_REQUEST",
                    "Native file chunk sequence overflow.",
                    &id,
                )
            })?;
            source.final_chunk = source.offset == source.size;
            let end = source.offset;
            source.pending.insert(sequence, end);
            let mut frame = Vec::with_capacity(24 + count);
            frame.extend_from_slice(b"QH01");
            frame.extend_from_slice(&sequence.to_le_bytes());
            frame.extend_from_slice(&offset.to_le_bytes());
            frame.extend_from_slice(&u32::from(source.final_chunk).to_le_bytes());
            frame.extend_from_slice(&(count as u32).to_le_bytes());
            frame.extend_from_slice(&bytes);
            Ok(frame)
        })
        .await
    }
    pub fn acknowledge(&self, owner: &str, id: &str, sequence: u32, offset: u64) -> Result<Value> {
        let mut sources = self.sources.lock().expect("sources poisoned");
        let source = sources
            .get(id)
            .cloned()
            .ok_or_else(|| error("NOT_FOUND", "Native file reader is absent.", id))?;
        let mut source = source
            .try_lock()
            .map_err(|_| error("CONFLICT", "Native file read already pending.", id))?;
        if source.owner != owner || source.pending.get(&sequence) != Some(&offset) {
            return Err(error(
                "INVALID_REQUEST",
                "File acknowledgement does not match an outstanding chunk.",
                id,
            ));
        }
        source.pending.remove(&sequence);
        if source.final_chunk && source.pending.is_empty() {
            sources.remove(id);
        }
        Ok(Value::Null)
    }
    pub async fn save(
        self: &Arc<Self>,
        window: WebviewWindow,
        session: Arc<Session>,
        request: String,
        name: String,
        media_type: String,
        transfer_id: String,
    ) -> Result<Value> {
        if name.is_empty()
            || name.len() > 255
            || name.contains(['/', '\\', '\0'])
            || name == "."
            || name == ".."
        {
            return Err(error(
                "INVALID_REQUEST",
                "Export requires a simple suggested filename.",
                &request,
            ));
        }
        let extensions = extensions(&[media_type], &request)?;
        let stage = self.stage(&session.id, &transfer_id)?;
        if !stage
            .state
            .try_lock()
            .map_err(|_| {
                error(
                    "CONFLICT",
                    "Export transfer already has pending IO.",
                    &request,
                )
            })?
            .verified
        {
            return Err(error(
                "INVALID_REQUEST",
                "Verify the export transfer before choosing its destination.",
                &request,
            ));
        }
        check_session(&session, &request)?;
        let op = self.operation(&session.id, &request)?;
        if let Err(error) = check_session(&session, &request) {
            op.token.cancel();
            op.state.lock().expect("operation poisoned").1 = true;
            return Err(error);
        }
        let result = async {
            let paths = self
                .pick(window, op.clone(), &request, false, Some(name), extensions)
                .await?;
            let path = paths
                .into_iter()
                .next()
                .ok_or_else(|| error("CANCELLED", "Native save dialog was cancelled.", &request))?;
            let rid = request.clone();
            let op = op.clone();
            self.run(&rid, move |_files| {
                check_session(&session, &request)?;
                save_stage(stage, op, &request, &path)
            })
            .await
        }
        .await;
        op.state.lock().expect("operation poisoned").1 = true;
        result
    }
    #[cfg(feature = "host-proof")]
    pub fn proof_stats(&self) -> Value {
        json!({"diskBytes":self.budget.load(Ordering::SeqCst),"diskStages":self.stages.lock().unwrap().len(),"fileHandles":self.grants.lock().unwrap().len(),"fileSources":self.sources.lock().unwrap().len(),"maxChunkBytes":CHUNK_BYTES,"ioSlots":4,"creditWindow":IN_FLIGHT})
    }
}
fn extensions(types: &[String], request: &str) -> Result<Vec<String>> {
    if types.len() > 32 {
        return Err(error(
            "INVALID_REQUEST",
            "Too many requested file types.",
            request,
        ));
    }
    let mut extensions = Vec::new();
    for value in types {
        match value.as_str() {
            "application/octet-stream" | "*/*" => return Ok(Vec::new()),
            "application/zip" => extensions.push("zip".into()),
            "application/json" => extensions.push("json".into()),
            "text/plain" => extensions.push("txt".into()),
            "text/markdown" => extensions.push("md".into()),
            "application/pdf" => extensions.push("pdf".into()),
            "image/png" => extensions.push("png".into()),
            "image/jpeg" => extensions.extend(["jpg".into(), "jpeg".into()]),
            _ => {
                return Err(error(
                    "UNSUPPORTED",
                    "This native file type filter is not registered; use an unrestricted picker explicitly.",
                    request,
                ));
            }
        }
    }
    Ok(extensions)
}
fn fingerprint(path: &Path) -> std::io::Result<Option<(u64, Option<std::time::SystemTime>)>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
            Ok(Some((metadata.len(), metadata.modified().ok())))
        }
        Ok(_) => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "not a regular destination",
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}
fn save_stage(
    stage: Arc<DiskStage>,
    op: Arc<FileOperation>,
    request: &str,
    path: &Path,
) -> Result<Value> {
    check_operation(&op, request)?;
    let mut stage_state = stage.state.try_lock().map_err(|_| {
        error(
            "CONFLICT",
            "Export transfer already has pending IO.",
            request,
        )
    })?;
    if !stage_state.verified || stage.cancelled.load(Ordering::SeqCst) {
        return Err(error(
            "INVALID_REQUEST",
            "Export transfer is not verified or was released.",
            request,
        ));
    }
    let parent = path
        .parent()
        .ok_or_else(|| {
            error(
                "INVALID_REQUEST",
                "Export destination needs a parent directory.",
                request,
            )
        })?
        .canonicalize()
        .map_err(|e| io_error(e, request))?;
    let path = parent.join(path.file_name().ok_or_else(|| {
        error(
            "INVALID_REQUEST",
            "Export destination needs a filename.",
            request,
        )
    })?);
    let before = fingerprint(&path).map_err(|e| io_error(e, request))?;
    let mut output = tempfile::Builder::new()
        .prefix(".quixi-export-")
        .tempfile_in(&parent)
        .map_err(|e| io_error(e, request))?;
    stage_state
        .file
        .seek(SeekFrom::Start(0))
        .map_err(|e| io_error(e, request))?;
    let mut buffer = vec![0; CHUNK_BYTES];
    let mut copied = 0;
    let mut hash = Sha256::new();
    loop {
        check_operation(&op, request)?;
        if stage.cancelled.load(Ordering::SeqCst) {
            return Err(error("CANCELLED", "Export staging was released.", request));
        }
        let count = stage_state
            .file
            .read(&mut buffer)
            .map_err(|e| io_error(e, request))?;
        if count == 0 {
            break;
        }
        output
            .write_all(&buffer[..count])
            .map_err(|e| io_error(e, request))?;
        copied += count as u64;
        hash.update(&buffer[..count]);
    }
    if copied != stage_state.size || hash.finalize() != stage_state.hasher.clone().finalize() {
        return Err(error(
            "IO_ERROR",
            "Export staging changed or became unreadable.",
            request,
        ));
    }
    output
        .as_file()
        .sync_all()
        .map_err(|e| io_error(e, request))?;
    check_operation(&op, request)?;
    if fingerprint(&path).map_err(|e| io_error(e, request))? != before {
        return Err(error(
            "CONFLICT",
            "Export destination changed while preparing the file; save again.",
            request,
        ));
    }
    {
        let mut state = op.state.lock().expect("operation poisoned");
        check_operation(&op, request)?;
        state.0 = true;
    }
    output
        .persist(&path)
        .map_err(|e| io_error(e.error, request))?;
    #[cfg(unix)]
    File::open(&parent)
        .and_then(|file| file.sync_all())
        .map_err(|_| {
            error(
                "UNKNOWN_OUTCOME",
                "Export file was replaced but directory durability could not be established.",
                request,
            )
        })?;
    Ok(Value::Null)
}
