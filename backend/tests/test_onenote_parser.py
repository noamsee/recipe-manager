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

    with pytest.raises(UnsupportedFileFormatError, match="No selectable text"):
        extract_text_from_onenote_bytes("scanned.pdf", content)
