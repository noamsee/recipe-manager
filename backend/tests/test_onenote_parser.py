"""Unit tests for OneNote export parsing across HTML, DOCX, and text."""

from io import BytesIO
from docx import Document
import pytest

from app.onenote_parser import (
    UnsupportedFileFormatError,
    _chunk_text,
    extract_text_from_onenote_bytes,
)


def test_extract_html_strips_scripts_and_preserves_hebrew() -> None:
    html = """
    <html>
      <head><style>.x{color:red}</style><script>alert(1)</script></head>
      <body>
        <h1>שקשוקה קלאסית</h1>
        <p>4 עגבניות</p>
        <p>3 ביצים</p>
      </body>
    </html>
    """.encode("utf-8")

    text = extract_text_from_onenote_bytes("recipes.html", html)
    assert "שקשוקה קלאסית" in text
    assert "4 עגבניות" in text
    assert "alert(1)" not in text
    assert "color:red" not in text


def test_extract_docx_reads_paragraphs_and_tables() -> None:
    doc = Document()
    doc.add_heading("Chocolate Mousse", level=1)
    doc.add_paragraph("200g dark chocolate")
    table = doc.add_table(rows=1, cols=2)
    table.rows[0].cells[0].text = "Prep"
    table.rows[0].cells[1].text = "15 mins"

    buf = BytesIO()
    doc.save(buf)

    text = extract_text_from_onenote_bytes("dessert.docx", buf.getvalue())
    assert "Chocolate Mousse" in text
    assert "200g dark chocolate" in text
    assert "Prep | 15 mins" in text


def test_rejects_unsupported_extension() -> None:
    with pytest.raises(UnsupportedFileFormatError):
        extract_text_from_onenote_bytes("notes.xlsx", b"dummy")


def test_chunk_text_splits_on_paragraph_boundaries() -> None:
    long_text = "\n\n".join([f"Paragraph {i} " + ("x" * 100) for i in range(10)])
    chunks = _chunk_text(long_text, max_chars=300)
    assert len(chunks) > 1
    assert all(len(c) <= 300 for c in chunks)


def test_pdf_without_text_raises_clear_error() -> None:
    from pypdf import PdfWriter

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    buf = BytesIO()
    writer.write(buf)
    # simulate a large blank/image PDF (> 50KB)
    content = buf.getvalue() + (b"0" * 60_000)

    with pytest.raises(UnsupportedFileFormatError, match="No selectable text|No readable text"):
        extract_text_from_onenote_bytes("scanned.pdf", content)


def test_compress_image_bytes_produces_valid_data_uri() -> None:
    from PIL import Image
    from app.onenote_parser import compress_image_bytes

    img = Image.new("RGB", (200, 200), color="blue")
    buf = BytesIO()
    img.save(buf, format="PNG")

    data_uri = compress_image_bytes(buf.getvalue())
    assert data_uri.startswith("data:image/jpeg;base64,")
    assert len(data_uri) > 50


def test_group_pdf_pages_into_units_combines_short_pages() -> None:
    from app.onenote_parser import group_pdf_pages_into_units

    pages = [
        {"page_num": 1, "text": "Chocolate Cake\n200g flour", "image_data_uri": "data:img1"},
        {"page_num": 2, "text": "1. Mix ingredients\n2. Bake 30 mins", "image_data_uri": ""},
        {"page_num": 3, "text": "Tomato Soup\n4 tomatoes", "image_data_uri": "data:img2"},
    ]

    # With max_chars_per_unit=60, pages 1 & 2 fit in unit 0, while page 3 starts unit 1
    units = group_pdf_pages_into_units(pages, max_chars_per_unit=60)
    assert len(units) == 2
    assert units[0]["pages"] == [1, 2]
    assert "Mix ingredients" in units[0]["text"]
    assert units[0]["image_data_uri"] == "data:img1"
    assert units[1]["pages"] == [3]
    assert units[1]["image_data_uri"] == "data:img2"
