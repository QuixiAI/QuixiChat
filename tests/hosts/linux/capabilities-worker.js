// Bounded synthetic OPFS diagnostic, independent of the product database.
(async () => {
  const report = {
    storage: !!navigator.storage, getDirectory: !!navigator.storage?.getDirectory,
    fileSystemHandle: typeof FileSystemHandle,
    fileSystemDirectoryHandle: typeof FileSystemDirectoryHandle,
    fileSystemFileHandle: typeof FileSystemFileHandle,
    createSyncAccessHandle: typeof globalThis.FileSystemFileHandle?.prototype?.createSyncAccessHandle,
    fileSystemSyncAccessHandle: typeof FileSystemSyncAccessHandle,
    secureContext: isSecureContext, steps: [],
  };
  let stage = "getDirectory";
  let directory, handle;
  const name = `quixi-host-diagnostic-${crypto.randomUUID()}`;
  try {
    directory = await navigator.storage.getDirectory();
    report.steps.push(stage);
    stage = "getFileHandle";
    const file = await directory.getFileHandle(name, { create: true });
    report.steps.push(stage);
    stage = "createSyncAccessHandle";
    handle = await file.createSyncAccessHandle();
    report.steps.push(stage);
    stage = "write-flush-read";
    handle.write(new Uint8Array([1, 3, 5, 7]));
    handle.flush();
    const bytes = new Uint8Array(4);
    handle.read(bytes, { at: 0 });
    if (bytes.join() !== "1,3,5,7") throw new Error("Synthetic OPFS roundtrip mismatch");
    report.steps.push(stage);
  } catch (error) {
    report.error = { stage, name: error.name, message: error.message };
  } finally {
    handle?.close();
    if (directory) {
      try { await directory.removeEntry(name); }
      catch (error) { if (error.name !== "NotFoundError") report.cleanupError = error.message; }
    }
  }
  postMessage(report);
})();
