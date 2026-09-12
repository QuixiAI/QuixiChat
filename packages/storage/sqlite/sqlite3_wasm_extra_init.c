/* Compiled into the official SQLite WASM library, never dynamically loaded. */
#define SQLITE_CORE 1
#define SQLITE_VEC_STATIC 1
#define SQLITE_VEC_OMIT_FS 1
#include "sqlite-vec.c"

int sqlite3_wasm_extra_init(const char *unused) {
  (void)unused;
  return sqlite3_auto_extension((void (*)(void))sqlite3_vec_init);
}
