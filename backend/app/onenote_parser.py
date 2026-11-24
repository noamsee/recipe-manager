"""Parsers for exported Microsoft OneNote files (.html, .docx, .pdf, .txt, .md)."""

from io import BytesIO
from pathlib import Path

from bs4 import BeautifulSoup
from docx import Document
from pypdf import PdfReader

from .gemini_client import GeminiRecipeService
from .schemas import ExtractedRecipe

SUPPORTED_ONENOTE_EXTENSIONS = {".html", ".htm", ".docx", ".pdf", ".txt", ".md"}
_MAX_CHARS_PER_CHUNK = 45000


class UnsupportedFileFormatError(ValueError):
    """Raised when an uploaded OneNote export has an unsupported file extension or unextractable content."""


def extract_text_from_onenote_bytes(filename: str, content: bytes) -> str:
    """Convert exported OneNote HTML, DOCX, PDF, or text bytes into clean plain text."""
    ext = Path(filename).suffix.lower()
    if ext not in SUPPORTED_ONENOTE_EXTENSIONS:
        raise UnsupportedFileFormatError(
            f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(SUPPORTED_ONENOTE_EXTENSIONS))}."
        )

    if ext in {".html", ".htm"}:
        soup = BeautifulSoup(content.decode("utf-8", errors="replace"), "html.parser")
        for tag in soup(["script", "style"]):
            tag.decompose()
        return "\n".join(line.strip() for line in soup.get_text("\n").splitlines() if line.strip())

    if ext == ".docx":
        doc = Document(BytesIO(content))
        parts: list[str] = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
        for table in doc.tables:
            for row in table.rows:
                cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
                if cells:
                    parts.append(" | ".join(cells))
        return "\n".join(parts)

    if ext == ".pdf":
        reader = PdfReader(BytesIO(content))
        pages = [(page.extract_text() or "").strip() for page in reader.pages]
        combined = "\n\n".join(p for p in pages if p)
        if not combined.strip() and len(content) > 50_000:
            raise UnsupportedFileFormatError(
                "No selectable text found in this PDF. It appears to contain scanned images or screenshots. "
                "Please export from OneNote as Word (.docx) or Web Page (.html), or copy-paste text directly."
            )
        return combined

    return content.decode("utf-8", errors="replace").strip()


def _chunk_text(text: str, max_chars: int = _MAX_CHARS_PER_CHUNK) -> list[str]:
    """Split large documents along paragraph boundaries to fit comfortably within LLM context."""
    if len(text) <= max_chars:
        return [text]

    chunks: list[str] = []
    current: list[str] = []
    current_len = 0

    for paragraph in text.split("\n\n"):
        para_len = len(paragraph) + 2
        if current and current_len + para_len > max_chars:
            chunks.append("\n\n".join(current))
            current = [paragraph]
            current_len = para_len
        else:
            current.append(paragraph)
            current_len += para_len

    if current:
        chunks.append("\n\n".join(current))
    return chunks


def parse_onenote_export(
    filename: str,
    content: bytes,
    gemini: GeminiRecipeService,
) -> list[ExtractedRecipe]:
    """Extract structured recipes from an exported OneNote document."""
    text = extract_text_from_onenote_bytes(filename, content)
    if not text.strip():
        return []

    all_recipes: list[ExtractedRecipe] = []
    for chunk in _chunk_text(text):
        all_recipes.extend(gemini.extract_from_onenote_text(chunk))
    return all_recipes
