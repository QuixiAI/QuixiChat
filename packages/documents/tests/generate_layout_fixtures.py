"""Generate only layout fixtures; never rewrite the existing fixture manifest.

Run: uv run --with reportlab==5.0.1 --with pypdf==6.18.0 --with pillow==12.3.0 --with charset-normalizer==3.4.7 python packages/documents/tests/generate_layout_fixtures.py
"""
from pathlib import Path
import hashlib
import json

from reportlab.pdfgen.canvas import Canvas
from reportlab.lib.colors import Color

ROOT = Path(__file__).parent / "fixtures"
PAGE = (612, 792)
INK = Color(0.12, 0.15, 0.2)
GREY = Color(0.55, 0.59, 0.63)


def canvas(name):
    result = Canvas(str(ROOT / name), pagesize=PAGE, invariant=1, pageCompression=1)
    result.setTitle(name)
    result.setAuthor("Quixi synthetic layout fixture")
    result.setSubject("Authored layout oracle; synthetic data only")
    result.setFillColor(INK)
    return result


def line(c, text, x, y, font="Helvetica", size=11):
    c.setFont(font, size)
    c.setFillColor(INK)
    c.drawString(x, y, text)


def header(c, text):
    line(c, text, 48, 750, "Helvetica-Bold", 16)
    c.setStrokeColor(GREY)
    c.setLineWidth(0.5)
    c.line(48, 733, 564, 733)


def footer(c, text):
    c.setStrokeColor(GREY)
    c.line(48, 68, 564, 68)
    line(c, text, 48, 49, size=10)


def block(kind, lines, **extra):
    return {"kind": kind, "lines": lines, **extra}


def generate():
    ROOT.mkdir(exist_ok=True)
    documents = {}
    c = canvas("layout-columns.pdf")
    pages = []
    for number in (1, 2):
        title = f"P{number}-TITLE: Two independent reading columns"
        end = f"P{number}-FOOTER: Read after both columns; synthetic page {number} of 2."
        left = [
            [f"P{number}-L1: The amber boat leaves first.",
             "Its quiet crew follows the western bank.",
             "This sentence ends the first paragraph."],
            [f"P{number}-L2: The second left paragraph starts.",
             "The copper lantern remains on shore."],
        ]
        right = [
            [f"P{number}-R1: The violet train leaves later.",
             "Its passengers follow the eastern ridge.",
             "This sentence ends the right paragraph."],
            [f"P{number}-R2: The final right paragraph starts.",
             "The silver station closes at dusk."],
        ]
        header(c, title)
        # Deliberately defeat content-stream order: right line before left line,
        # interleaved within each paragraph, even though left column reads first.
        for index, top in enumerate((699, 627)):
            for row, (left_text, right_text) in enumerate(zip(left[index], right[index])):
                line(c, right_text, 336, top - row * 15, size=10)
                line(c, left_text, 48, top - row * 15, size=10)
        footer(c, end)
        pages.append({"page": number, "expectedBlocks": [
            block("heading", [title]),
            *[block("paragraph", lines, column="left") for lines in left],
            *[block("paragraph", lines, column="right") for lines in right],
            block("footer", [end]),
        ], "columnLeftX": [48, 336], "bodyBaselineY": [699, 684, 669, 627, 612]})
        c.showPage()
    c.save()
    documents["layout-columns.pdf"] = {"pages": pages, "unsupported": []}

    c = canvas("layout-table-code.pdf")
    header(c, "TABLE-TITLE: Three cells per row")
    rows = [
        ["Item", "Quantity", "Note"],
        ["amber", "7", "warm sample"],
        ["cobalt", "12", "cool sample"],
        ["jade", "4", "green sample"],
    ]
    # Real distinct text objects and ruled cells, no literal pipe characters.
    xs = [60, 224, 390]
    ys = [688, 649, 610, 571]
    c.setStrokeColor(GREY)
    for x in (48, 212, 378, 564):
        c.line(x, 553, x, 715)
    for y in (715, 676, 637, 598, 553):
        c.line(48, y, 564, y)
    # Column-major drawing order is intentionally unlike row-major reading.
    for column in (2, 0, 1):
        for row, cells in enumerate(rows):
            line(c, cells[column], xs[column], ys[row], "Helvetica-Bold" if row == 0 else "Helvetica")
    after = ["TABLE-AFTER: The paragraph follows all four rows.",
             "The cell boundaries are structural, not literal text separators."]
    for index, text in enumerate(after):
        line(c, text, 48, 509 - 16 * index)
    footer(c, "TABLE-FOOTER: End of the table page.")
    c.showPage()
    header(c, "CODE-TITLE: Preserve indentation and list structure")
    intro = ["CODE-INTRO: The next eight lines are one code block.",
             "Whitespace inside that block carries indentation."]
    for index, text in enumerate(intro):
        line(c, text, 48, 699 - 16 * index)
    code = [
        "// CODE-START: nested accumulation",
        "function total(values) {",
        "  let sum = 0;",
        "  for (const value of values) {",
        "    sum += value;",
        "  }",
        "  return sum; // CODE-END",
        "}",
    ]
    # Exact authored spaces exist in the PDF string operands themselves.
    for index, text in enumerate(code):
        line(c, text, 64, 641 - 15 * index, "Courier", 10)
    list_lines = [
        "1. LIST-ONE: Pack the amber map.",
        "   Keep the folded copy with the original item.",
        "2. LIST-TWO: Check the violet compass.",
        "   a. LIST-NESTED: Record the northern bearing.",
        "3. LIST-THREE: Close the copper case.",
    ]
    for index, text in enumerate(list_lines):
        line(c, text, 64, 459 - 18 * index, "Courier", 10)
    after_code = ["CODE-AFTER: This is a separate prose paragraph.",
                  "It must not become part of the final list item."]
    for index, text in enumerate(after_code):
        line(c, text, 48, 320 - 16 * index)
    footer(c, "CODE-FOOTER: End of the code and list page.")
    c.showPage()
    c.save()
    documents["layout-table-code.pdf"] = {"pages": [
        {"page": 1, "expectedBlocks": [
            block("heading", ["TABLE-TITLE: Three cells per row"]),
            {"kind": "table", "rows": rows},
            block("paragraph", after),
            block("footer", ["TABLE-FOOTER: End of the table page."]),
        ], "cellLeftX": xs, "rowBaselineY": ys},
        {"page": 2, "expectedBlocks": [
            block("heading", ["CODE-TITLE: Preserve indentation and list structure"]),
            block("paragraph", intro), block("code", code), block("list", list_lines),
            block("paragraph", after_code),
            block("footer", ["CODE-FOOTER: End of the code and list page."]),
        ]},
    ], "unsupported": []}

    c = canvas("layout-unsupported.pdf")
    header(c, "GEOMETRY-TITLE: Mixed horizontal and rotated text")
    line(c, "HORIZONTAL-ONE: This text has an ordinary baseline.", 48, 693)
    line(c, "HORIZONTAL-TWO: Rotated anchors are separate objects.", 48, 670)
    c.saveState()
    c.translate(86, 335)
    c.rotate(90)
    line(c, "ROTATE-90: vertical baseline", 0, 0, "Helvetica-Bold", 12)
    c.restoreState()
    c.saveState()
    c.translate(258, 344)
    c.rotate(45)
    line(c, "ROTATE-45: diagonal baseline", 0, 0, "Helvetica-Bold", 12)
    c.restoreState()
    line(c, "HORIZONTAL-AFTER: Do not silently stitch rotated text into prose.", 48, 238)
    footer(c, "GEOMETRY-FOOTER: Unsupported geometry is explicit.")
    c.showPage()
    c.save()
    documents["layout-unsupported.pdf"] = {"pages": [{
        "page": 1, "sourceAnchors": [
            "GEOMETRY-TITLE: Mixed horizontal and rotated text",
            "HORIZONTAL-ONE: This text has an ordinary baseline.",
            "HORIZONTAL-TWO: Rotated anchors are separate objects.",
            "ROTATE-90: vertical baseline", "ROTATE-45: diagonal baseline",
            "HORIZONTAL-AFTER: Do not silently stitch rotated text into prose.",
            "GEOMETRY-FOOTER: Unsupported geometry is explicit.",
        ], "rotationsDegrees": [90, 45],
    }], "unsupported": ["mixed rotated baselines"],
        "notCovered": ["RTL: no verified RTL-capable pinned font is bundled; no missing-glyph substitute is used"]}

    for name, description in documents.items():
        data = (ROOT / name).read_bytes()
        description["bytes"] = len(data)
        description["sha256"] = hashlib.sha256(data).hexdigest()
    (ROOT / "layout-manifest.json").write_text(json.dumps({
        "generator": "ReportLab 5.0.1; invariant=1; built-in Helvetica/Courier",
        "coordinateSystem": "PDF points, bottom-left origin; pages 612x792",
        "documents": documents,
    }, indent=2) + "\n")


if __name__ == "__main__":
    generate()
