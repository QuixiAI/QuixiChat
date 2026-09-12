fn main() {
    // `tauri::generate_context!` writes generated assets beneath OUT_DIR; the
    // build script is what makes that directory available to the macro.
    tauri_build::build();
}
