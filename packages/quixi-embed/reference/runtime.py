"""OFFLINE ONLY: pinned eager CPU FP32 correctness oracle; never imported by JS."""
import importlib.metadata
import os
from pathlib import Path
import platform
import sys
import time

os.environ['TOKENIZERS_PARALLELISM'] = 'false'
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'

import numpy as np
import torch
from transformers import AutoModel, AutoTokenizer
from fetch import ROOT, verify, sha256

QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '


def environment():
    return {
        'python': sys.version.split()[0], 'platform': platform.platform(),
        'machine': platform.machine(), 'processor': platform.processor(),
        'packages': {name: importlib.metadata.version(name) for name in
                     ('torch', 'transformers', 'tokenizers', 'safetensors', 'numpy')},
        'threads': torch.get_num_threads(), 'backend': 'torch-cpu-eager-fp32',
        'requirements_sha256': sha256(ROOT / 'reference/requirements.txt'),
    }


class Reference:
    def __init__(self, source=None, threads=1):
        self.source = Path(source or ROOT / 'build/source')
        self.lock = verify(self.source)
        torch.set_num_threads(threads)
        torch.manual_seed(0)
        torch.use_deterministic_algorithms(True)
        begin = time.perf_counter()
        self.tokenizer = AutoTokenizer.from_pretrained(self.source, local_files_only=True, use_fast=True)
        self.model = AutoModel.from_pretrained(
            self.source, local_files_only=True, add_pooling_layer=False,
            attn_implementation='eager', torch_dtype=torch.float32,
        ).cpu().eval()
        self.cold_load_ms = (time.perf_counter() - begin) * 1000
        assert self.model.config.hidden_size == 384
        assert self.model.config.num_hidden_layers == 6
        assert self.model.config.max_position_embeddings == 512

    def tokenize(self, texts, role):
        if role not in ('query', 'document'):
            raise ValueError('role must be query or document')
        if not texts or not all(isinstance(text, str) for text in texts):
            raise ValueError('texts must be a nonempty list of strings')
        return self.tokenizer(
            [(QUERY_PREFIX if role == 'query' else '') + text for text in texts],
            padding=True, truncation=True, max_length=512, return_tensors='pt',
        )

    def forward(self, texts, role, stages=False):
        tokens = self.tokenize(texts, role)
        with torch.inference_mode():
            out = self.model(**tokens, output_hidden_states=stages)
            pooled = out.last_hidden_state[:, 0]
            vectors = torch.nn.functional.normalize(pooled, p=2, dim=1, eps=1e-12)
        result = {key: value.numpy() for key, value in tokens.items()}
        result['pooled'] = pooled.numpy()
        result['vectors'] = vectors.numpy()
        if stages:
            for i, state in enumerate(out.hidden_states):
                result[f'stage_{i}'] = state.numpy()
        return result

    def embed(self, texts, role, batch_size=16):
        if not 1 <= batch_size <= 32:
            raise ValueError('offline batch_size must be in 1..32')
        return np.concatenate([self.forward(texts[i:i + batch_size], role)['vectors']
                               for i in range(0, len(texts), batch_size)])
