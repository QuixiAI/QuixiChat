"""Deterministic, admitted native-text workload. Synthetic content CC0-1.0."""
from pathlib import Path
import hashlib, json
import reportlab, pypdf
from reportlab.pdfgen.canvas import Canvas
from pypdf import PdfReader
assert reportlab.Version == '5.0.1' and pypdf.__version__ == '6.18.0'
root = Path(__file__).parent / 'fixtures'
root.mkdir(exist_ok=True)
manifest = {}
for pages in (1, 10, 100):
    path = root / f'dense-{pages}.pdf'
    canvas = Canvas(str(path), pagesize=(2400, 10000), invariant=1, pageCompression=1)
    expected_utf16 = []
    for page in range(1, pages + 1):
        canvas.setFont('Helvetica', 8)
        lines = []
        for line in range(1000):
            prefix = f'Quixi document fixture page {page:03d} line {line:04d} '
            text = (prefix + 'amber birch cedar delta elm fern grove harbor iris juniper kelp larch maple north oak pine quartz river spruce timber ' * 2)[:150]
            canvas.drawString(20, 9960 - line * 9, text)
            lines.append(text)
        expected_utf16.append(sum(map(len, lines)))
        canvas.showPage()
    canvas.save()
    reader = PdfReader(path)
    assert len(reader.pages) == pages
    verified = []
    for page in reader.pages:
        text = page.extract_text()
        assert text.count('Quixi document fixture') == 1000
        assert 150000 <= len(text) <= 152000, len(text)
        verified.append(len(text))
    size = path.stat().st_size
    assert size <= 32 * 1024 * 1024
    manifest[path.name] = {'bytes': size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'pages': pages, 'positionedTextLinesPerPage': 1000, 'charactersPerLine': 150, 'contentUTF16PerPageWithoutSeparators': 150000, 'pypdfTextUTF16PerPageRange': [min(verified), max(verified)], 'pagePoints': [2400, 10000], 'generator': {'reportlab': reportlab.Version, 'pypdf': pypdf.__version__, 'pillow': '12.3.0', 'charset-normalizer': '3.4.7'}, 'license': 'CC0-1.0', 'scope': 'Dense native-text extraction and mapping workload, no images; actual PDF.js normalized output/item admission checked by production persistence, not inferred from pypdf.'}
(root / 'dense-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
