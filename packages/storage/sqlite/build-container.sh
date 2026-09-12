#!/usr/bin/env bash
set -euo pipefail
cd /src
export SOURCE_DATE_EPOCH=1785542400
export LC_ALL=C
export TZ=UTC
# The pinned SDK ships Binaryen. Only strip metadata, preserving export names.
mkdir -p build/bin
cat > build/bin/wasm-strip <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
/emsdk/upstream/bin/wasm-opt --all-features --strip-debug --strip-producers "$1" -o "$1"
SCRIPT
chmod +x build/bin/wasm-strip
export PATH="/src/build/bin:$PATH"
cd build/sqlite-src-3530400
./configure --disable-tcl
cp ../sqlite-amalgamation-3530400/sqlite3.c .
cp ../sqlite-amalgamation-3530400/sqlite3.h .
cp ../sqlite-amalgamation-3530400/sqlite3ext.h .
cp /src/sqlite3_wasm_extra_init.c ext/wasm/
cp ../vec/sqlite-vec.c ../vec/sqlite-vec.h ext/wasm/
cd ext/wasm
make -j2 loud=1 emcc_opt=-O2 emcc.environment=-sENVIRONMENT=web,worker,node jswasm/sqlite3.mjs
mkdir -p /src/dist
cp jswasm/sqlite3.mjs jswasm/esm/sqlite3.wasm /src/dist/
cp /src/sqlite3.d.mts /src/dist/
