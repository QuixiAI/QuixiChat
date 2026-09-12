"""Pinned synthetic source-size stress fixture; no user images or PDF byte editing."""
from pathlib import Path
import hashlib, json, random
from PIL import Image
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.utils import ImageReader
from pypdf import PdfReader
root = Path(__file__).parent / 'fixtures'
root.mkdir(exist_ok=True)
path = root / 'image-heavy.pdf'
image = Image.frombytes('RGB', (2880, 2880), random.Random(20260909).randbytes(2880 * 2880 * 3))
canvas = Canvas(str(path), invariant=1, pageCompression=1)
canvas.drawImage(ImageReader(image), 30, 120, 530, 530)
canvas.setFont('Helvetica', 12)
canvas.drawString(30, 760, 'Quixi document fixture: image-heavy source, native text retained.')
canvas.showPage()
canvas.save()
reader = PdfReader(path)
assert len(reader.pages) == 1
assert 'native text retained' in reader.pages[0].extract_text()
assert len(reader.pages[0].images) == 1
assert reader.pages[0].images[0].image.size == (2880, 2880)
size = path.stat().st_size
assert 29 * 1024 * 1024 < size < 32 * 1024 * 1024, size
manifest = {'image-heavy.pdf': {'bytes': size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'pages': 1, 'imagePixels': [2880, 2880], 'seed': 20260909, 'generator': {'reportlab': '5.0.1', 'pypdf': '6.18.0', 'pillow': '12.3.0', 'charset-normalizer': '3.4.7'}, 'license': 'CC0-1.0 synthetic fixture', 'scope': 'Source-size/range/hash stress. Text-only PDF.js extraction need not decode the embedded image.'}}
(root / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))
