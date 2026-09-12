import ctypes as C
import hashlib
from pathlib import Path
import struct
import unittest
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "reference"))
from fetch import ROOT
from native_runtime import PRODUCTION_LIBRARY


class NativeSafetyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lib = C.CDLL(str(PRODUCTION_LIBRARY))
        cls.lib.qx_model_load.argtypes = [C.c_void_p,C.c_size_t,C.POINTER(C.c_int)]
        cls.lib.qx_model_load.restype = C.c_void_p
        cls.lib.qx_model_free.argtypes = [C.c_void_p]
        cls.lib.qx_tokenizer_load.argtypes = [C.c_void_p,C.c_size_t,C.POINTER(C.c_int)]
        cls.lib.qx_tokenizer_load.restype = C.c_void_p
        cls.lib.qx_tokenizer_free.argtypes = [C.c_void_p]
        cls.lib.qx_tokenizer_encode.argtypes = [C.c_void_p,C.c_void_p,C.c_size_t,C.c_uint32,C.c_void_p,C.POINTER(C.c_uint32)]
        cls.lib.qx_workspace_create.argtypes = [C.c_uint32];cls.lib.qx_workspace_create.restype = C.c_void_p
        cls.lib.qx_sha256.argtypes = [C.c_void_p,C.c_size_t,C.c_void_p]
        cls.original = (ROOT / 'build/arctic-xs.qxmodel').read_bytes()

    def reject(self, data, expected):
        status=C.c_int();owned=bytes(data)
        result=self.lib.qx_model_load(owned,len(owned),C.byref(status))
        if result:
            self.lib.qx_model_free(result)
        self.assertFalse(result)
        self.assertEqual(status.value,expected)

    def test_sha256_known_vectors(self):
        for data in [b'',b'abc',b'a'*55,b'a'*56,b'a'*64,b'a'*1000]:
            out=(C.c_uint8*32)();self.lib.qx_sha256(data,len(data),out)
            self.assertEqual(bytes(out),hashlib.sha256(data).digest())

    def test_version_truncation_and_identity(self):
        bad=bytearray(self.original);struct.pack_into('<I',bad,8,2);self.reject(bad,4)
        self.reject(self.original[:100],3)
        bad=bytearray(self.original);bad[32]^=1;self.reject(bad,5)

    def test_corrupt_and_rehashed_tensor_rejected(self):
        bad=bytearray(self.original);bad[11000]^=1;self.reject(bad,5)
        bad[64:96]=hashlib.sha256(bad[128:]).digest();self.reject(bad,5)

    def test_out_of_bounds_and_wrong_shape_rejected(self):
        bad=bytearray(self.original);struct.pack_into('<Q',bad,128+8,2**64-64)
        bad[64:96]=hashlib.sha256(bad[128:]).digest();self.reject(bad,3)
        bad=bytearray(self.original);struct.pack_into('<I',bad,256+80,999)
        bad[64:96]=hashlib.sha256(bad[128:]).digest();self.reject(bad,3)

    def test_limits_and_malformed_utf8(self):
        self.assertFalse(self.lib.qx_workspace_create(513))
        self.assertFalse(self.lib.qx_workspace_create(0))
        source=(ROOT/'build/arctic-xs.qxtokenizer').read_bytes();status=C.c_int()
        tokenizer=self.lib.qx_tokenizer_load(source,len(source),C.byref(status));self.assertTrue(tokenizer)
        try:
            out=(C.c_uint32*512)();count=C.c_uint32()
            for data in [b'\xc0\x80',b'\xed\xa0\x80',b'\xf4\x90\x80\x80',b'\xff',b'\xe2\x82']:
                self.assertEqual(self.lib.qx_tokenizer_encode(tokenizer,data,len(data),0,out,C.byref(count)),7)
            self.assertEqual(self.lib.qx_tokenizer_encode(tokenizer,b'x',1024*1024+1,0,out,C.byref(count)),2)
            self.assertEqual(self.lib.qx_tokenizer_encode(tokenizer,b'x',1,3,out,C.byref(count)),1)
        finally:
            self.lib.qx_tokenizer_free(tokenizer)


if __name__ == '__main__':
    unittest.main()
