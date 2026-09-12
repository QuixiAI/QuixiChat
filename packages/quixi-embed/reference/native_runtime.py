"""ctypes adapter for the owned C scalar runtime; no graph execution in Python."""
import ctypes as C
import sys
from pathlib import Path
import numpy as np
from fetch import ROOT
DEFAULT_LIBRARY = ROOT / ("build/libquixi_embed.dylib" if sys.platform == "darwin" else "build/libquixi_embed.so")
PRODUCTION_LIBRARY = ROOT / ("build/libquixi_embed_production.dylib" if sys.platform == "darwin" else "build/libquixi_embed_production.so")


class Native:
    def __init__(self, model=None, library=None):
        library = library or DEFAULT_LIBRARY
        self.library = C.CDLL(str(library))
        lib = self.library
        lib.qx_model_load.argtypes = [C.c_void_p, C.c_size_t, C.POINTER(C.c_int)]
        lib.qx_model_load.restype = C.c_void_p
        lib.qx_model_free.argtypes = [C.c_void_p]
        lib.qx_model_bytes.argtypes = [C.c_void_p];lib.qx_model_bytes.restype = C.c_size_t
        lib.qx_workspace_create.argtypes = [C.c_uint32];lib.qx_workspace_create.restype = C.c_void_p
        lib.qx_workspace_free.argtypes = [C.c_void_p]
        lib.qx_workspace_bytes.argtypes = [C.c_void_p];lib.qx_workspace_bytes.restype = C.c_size_t
        lib.qx_tokenize.argtypes = [C.c_void_p, C.c_void_p, C.c_size_t, C.c_uint32, C.c_void_p, C.POINTER(C.c_uint32)]
        lib.qx_embed_tokens.argtypes = [C.c_void_p, C.c_void_p, C.c_void_p, C.c_void_p, C.c_uint32, C.c_void_p]
        lib.qx_diagnostic_stage.argtypes = [C.c_void_p, C.c_uint32];lib.qx_diagnostic_stage.restype = C.POINTER(C.c_float)
        lib.qx_diagnostic_pooled.argtypes = [C.c_void_p];lib.qx_diagnostic_pooled.restype = C.POINTER(C.c_float)
        self.model = self.workspace = None
        data = Path(model or ROOT / 'build/arctic-xs.qxmodel').read_bytes()
        status = C.c_int()
        self.model = lib.qx_model_load(data, len(data), C.byref(status))
        if not self.model:
            raise ValueError(f'qx_model_load: status {status.value}')
        self.workspace = lib.qx_workspace_create(512)
        if not self.workspace:
            self.close()
            raise MemoryError('qx_workspace_create')

    def close(self):
        if self.workspace:
            self.library.qx_workspace_free(self.workspace);self.workspace = None
        if self.model:
            self.library.qx_model_free(self.model);self.model = None

    def tokenize(self, text, role):
        if role not in ('query', 'document'):
            raise ValueError('invalid role')
        encoded = text.encode('utf-8')
        result = np.empty(512, dtype=np.uint32)
        count = C.c_uint32()
        status = self.library.qx_tokenize(self.model, encoded, len(encoded), int(role == 'query'),
                                           result.ctypes.data, C.byref(count))
        if status:
            raise ValueError(f'qx_tokenize: status {status}')
        return result[:count.value].copy()

    def forward(self, texts, role, stages=False):
        tokenized = [self.tokenize(text, role) for text in texts]
        length = max(map(len, tokenized))
        ids = np.zeros((len(texts), length), dtype=np.uint32)
        masks = np.zeros_like(ids)
        for row, tokens in enumerate(tokenized):
            ids[row, :len(tokens)] = tokens;masks[row, :len(tokens)] = 1
        vectors = np.empty((len(texts), 384), dtype=np.float32)
        pooled = np.empty_like(vectors)
        result = {'input_ids': ids.astype(np.int64), 'attention_mask': masks.astype(np.int64),
                  'token_type_ids': np.zeros_like(ids, dtype=np.int64), 'vectors': vectors, 'pooled': pooled}
        if stages:
            for stage in range(7):
                result[f'stage_{stage}'] = np.empty((len(texts), length, 384), dtype=np.float32)
        for row in range(len(texts)):
            status = self.library.qx_embed_tokens(self.model, self.workspace, ids[row].ctypes.data,
                    masks[row].ctypes.data, length, vectors[row].ctypes.data)
            if status:
                raise ValueError(f'qx_embed_tokens: status {status}')
            pooled[row] = np.ctypeslib.as_array(self.library.qx_diagnostic_pooled(self.workspace), shape=(384,))
            if stages:
                for stage in range(7):
                    ptr = self.library.qx_diagnostic_stage(self.workspace, stage)
                    result[f'stage_{stage}'][row] = np.ctypeslib.as_array(ptr, shape=(length * 384,)).reshape(length, 384)
        return result
