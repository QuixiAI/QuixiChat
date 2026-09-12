"""Generate one scanned page with a searchable one-character footer.

Run with the same pinned ReportLab/Pillow environment as generate_fixtures.py.
Standalone execution updates only this fixture and its manifest entry.
"""
from pathlib import Path
import hashlib
import json
from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.utils import ImageReader
from PIL import Image


def generate(root: Path) -> Path:
    path = root / 'low-text.pdf'
    canvas = Canvas(str(path), invariant=1)
    canvas.drawImage(ImageReader(Image.new('RGB', (600, 600), (70, 100, 140))), 40, 400, 300, 300)
    canvas.setFont('Helvetica', 10)
    canvas.drawString(40, 380, '1')
    canvas.showPage()
    canvas.save()
    return path


if __name__ == '__main__':
    root = Path(__file__).parent / 'fixtures'
    path = generate(root)
    manifest_path = root / 'manifest.json'
    manifest = json.loads(manifest_path.read_text())
    manifest[path.name] = {'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
    manifest_path.write_text(json.dumps(dict(sorted(manifest.items())), indent=2) + '\n')
