# Run: uv run --with reportlab==5.0.1 --with pypdf==6.18.0 --with pillow==12.3.0 --with charset-normalizer==3.4.7 python packages/documents/tests/generate_fixtures.py
from pathlib import Path
import hashlib, json
from reportlab.pdfgen.canvas import Canvas
from pypdf import PdfReader, PdfWriter
from PIL import Image
from reportlab.lib.utils import ImageReader
from generate_low_text_fixture import generate as generate_low_text
from generate_layout_fixtures import generate as generate_layout
ROOT = Path(__file__).parent / 'fixtures'
ROOT.mkdir(exist_ok=True)
generate_low_text(ROOT)
generate_layout()
for count in (1, 100, 1000, 1001):
    c = Canvas(str(ROOT / f'pages-{count}.pdf'), invariant=1, pageCompression=1)
    for page in range(1, count + 1):
        c.setFont('Helvetica', 16)
        c.drawString(40, 780, f'Quixi document fixture page {page}')
        c.setFont('Helvetica', 11)
        c.drawString(40, 750, 'Left column: exact source provenance.')
        c.drawString(315, 750, 'Right column: bounded extraction.')
        c.drawString(40, 720, 'Table: name | value')
        c.drawString(40, 705, 'alpha | 42')
        c.setFont('Courier', 10)
        c.drawString(40, 675, 'const synthetic = true;')
        c.showPage()
    c.save()
c = Canvas(str(ROOT / 'scanned.pdf'), invariant=1)
c.drawImage(ImageReader(Image.new('RGB', (600, 600), (70, 100, 140))), 40, 400, 300, 300)
c.showPage(); c.save()
c = Canvas(str(ROOT / 'dense-page.pdf'), invariant=1)
c.setFont('Helvetica', 0.001)
c.drawString(40, 750, 'A' * 262145)
c.showPage(); c.save()
reader = PdfReader(ROOT / 'pages-1.pdf')
w = PdfWriter(); w.append(reader); w.encrypt('synthetic-test-password');
with (ROOT / 'encrypted.pdf').open('wb') as f: w.write(f)
w = PdfWriter(); w.append(reader)
w.add_js("globalThis.__quixiEmbeddedAction = true; app.launchURL('https://example.invalid/quixi-document-action');")
with (ROOT / 'actions.pdf').open('wb') as f: w.write(f)
(ROOT / 'malformed.pdf').write_bytes(b'%PDF-1.7\nThis is a truncated synthetic document.\n')
(ROOT / 'unicode.txt').write_text('\ufeff' + 'a' * 4094 + '😀' + 'a' * 61432 + '😀 café\nMarkdown **exact**\n', encoding='utf-8')
(ROOT / 'invalid-utf8.txt').write_bytes(b'prefix\xffsuffix')
manifest = {p.name: {'bytes':p.stat().st_size, 'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(ROOT.iterdir()) if p.suffix in ('.pdf', '.txt')}
(ROOT / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
