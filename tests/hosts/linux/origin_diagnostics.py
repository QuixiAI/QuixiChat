"""Container-only instrumentation of the same Tauri host for origin comparison."""
import json
import os
from pathlib import Path
import subprocess


def instrument():
    path = Path("/work/apps/desktop/src-tauri/src/storage_proof.rs")
    source = path.read_text()
    anchor = "    tauri::Builder::default()"
    assert source.count(anchor) == 1
    source = source.replace(anchor, '''    if std::env::var("QUIXI_LINUX_ORIGIN_DIAGNOSTIC").as_deref() == Ok("http") {
        context.config_mut().app.windows[0].url = tauri::WebviewUrl::External(
            "http://127.0.0.1:1437/index.html".parse().unwrap(),
        );
    }
''' + anchor)
    anchor = "            if payload.event() == PageLoadEvent::Finished {"
    assert source.count(anchor) == 1
    source = source.replace(anchor, anchor + '''
                if std::env::var_os("QUIXI_LINUX_ORIGIN_DIAGNOSTIC").is_some() {
                    webview.eval("window.__quixiOriginReport={pending:true,url:location.href,secureContext:isSecureContext,crossOriginIsolated,userAgent:navigator.userAgent,storage:!!navigator.storage,getDirectory:!!navigator.storage?.getDirectory,storageManager:typeof StorageManager,fileSystemHandle:typeof FileSystemHandle,fileSystemSyncAccessHandle:typeof FileSystemSyncAccessHandle,webLocks:!!navigator.locks,worker:typeof Worker==='function',broadcastChannel:typeof BroadcastChannel==='function'}; const probeWorker=new Worker('/linux-capabilities-worker.js',{type:'module'}); probeWorker.onmessage=({data})=>{window.__quixiOriginReport.workerProbe=data;window.__quixiOriginReport.pending=false;probeWorker.terminate()};probeWorker.onerror=(event)=>{window.__quixiOriginReport.workerError=event.message;window.__quixiOriginReport.pending=false};").unwrap();
                    let target = webview.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        let handle = target.app_handle().clone();
                        target.eval_with_callback("window.__quixiOriginReport",
                            move |result| { println!("QUIXI_LINUX_CAPABILITIES={result}"); handle.exit(0); },
                        ).expect("could not inspect WebView origin capabilities");
                    });
                    return;
                }
''')
    path.write_text(source)


def run(enable_features=False):
    server = subprocess.Popen(["python3", "-m", "http.server", "1437", "--bind", "127.0.0.1", "--directory", "/work/apps/desktop/dist"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    results = []
    try:
        for origin in ("tauri", "http"):
            env = {**os.environ, "QUIXI_LINUX_ORIGIN_DIAGNOSTIC": origin, "QUIXI_PROOF_NAMESPACE": "linux-origin-diagnostic", "QUIXI_PROOF_PHASE": "write"}
            command = ["runuser", "-u", "quixi", "--"]
            if enable_features:
                command += ["env", "LD_PRELOAD=/tmp/quixi-enable-storage.so"]
            command += ["dbus-run-session", "--", "xvfb-run", "-a", "/work/target/debug/quixi-desktop"]
            result = subprocess.run(command, env=env, capture_output=True, text=True, timeout=105)
            lines = [line.split("=", 1)[1] for line in result.stdout.splitlines() if line.startswith("QUIXI_LINUX_CAPABILITIES=")]
            entry = {"origin": origin, "exitCode": result.returncode, "stderr": result.stderr[-4000:]}
            if lines:
                entry["capabilities"] = json.loads(lines[-1])
            else:
                entry["error"] = "No origin capability report"
                entry["stdoutTail"] = result.stdout[-4000:]
            results.append(entry)
    finally:
        server.terminate()
        server.wait(timeout=5)
    return results
