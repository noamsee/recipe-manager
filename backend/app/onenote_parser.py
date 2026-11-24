"""Parsers for exported Microsoft OneNote files (.html, .docx, .pdf, .txt, .md)."""

from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from pathlib import Path
import base64
import time

from bs4 import BeautifulSoup
from docx import Document
from PIL import Image
from pypdf import PdfReader

from .gemini_client import GeminiRecipeService
from .schemas import ExtractedRecipe, UnparsedCandidate

SUPPORTED_ONENOTE_EXTENSIONS = {".html", ".htm", ".docx", ".pdf", ".txt", ".md"}
_MAX_CHARS_PER_CHUNK = 45000


class UnsupportedFileFormatError(ValueError):
    """Raised when an uploaded OneNote export has an unsupported file extension or unextractable content."""


def compress_image_bytes(image_bytes: bytes, max_width: int = 600, quality: int = 75) -> str:
    """Compress raw image bytes into a web-optimized JPEG data URI."""
    try:
        img = Image.open(BytesIO(image_bytes))
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        scale = max_width / img.width if img.width > max_width else 1.0
        if scale < 1.0:
            new_size = (int(img.width * scale), int(img.height * scale))
            img = img.resize(new_size, Image.Resampling.LANCZOS)
        out = BytesIO()
        img.save(out, format="JPEG", quality=quality)
        b64 = base64.b64encode(out.getvalue()).decode("utf-8")
        return f"data:image/jpeg;base64,{b64}"
    except Exception:
        return ""


def extract_pdf_pages_and_images(content: bytes) -> list[dict]:
    """
    Extract text and primary food images page-by-page from a OneNote PDF export.
    Returns a list of page dicts: [{'page_num': int, 'text': str, 'image_data_uri': str}, ...]
    """
    reader = PdfReader(BytesIO(content))
    pages_data: list[dict] = []

    for idx, page in enumerate(reader.pages):
        text = (page.extract_text() or "").strip()

        # Extract largest embedded photo on this page
        best_img_bytes = None
        best_size = 0
        try:
            for img_file in page.images:
                data = img_file.data
                # Ignore small decorative icons / bullets under 3.5 KB
                if len(data) > 3500 and len(data) > best_size:
                    best_size = len(data)
                    best_img_bytes = data
        except Exception:
            pass

        data_uri = compress_image_bytes(best_img_bytes) if best_img_bytes else ""
        if text or data_uri:
            pages_data.append({
                "page_num": idx + 1,
                "text": text,
                "image_data_uri": data_uri,
            })

    return pages_data


def _build_unit(pages: list[dict]) -> dict:
    page_nums = [p["page_num"] for p in pages]
    page_images = {p["page_num"]: p["image_data_uri"] for p in pages if p.get("image_data_uri")}
    first_img = next((p["image_data_uri"] for p in pages if p.get("image_data_uri")), "")

    text_parts = []
    for p in pages:
        p_num = p["page_num"]
        p_text = p.get("text", "").strip()
        if p_text:
            text_parts.append(f"=== PAGE {p_num} ===\n{p_text}")

    return {
        "pages": page_nums,
        "text": "\n\n".join(text_parts),
        "image_data_uri": first_img,
        "page_images": page_images,
        "raw_pages": pages,
    }


def group_pdf_pages_into_units(
    pages_data: list[dict],
    max_chars_per_unit: int = 15000,
    max_pages_per_unit: int = 6,
) -> list[dict]:
    """
    Group consecutive PDF pages into multi-page batches (up to 15,000 characters or 6 pages each).
    This consolidates a 25-page PDF into just 3-4 LLM requests, preventing quota exhaustion
    on Gemini Free Tier (which limits Gemini models to 20 requests per day) while remaining
    well within Gemini's 8,192 structured output token limit.
    """
    if not pages_data:
        return []

    units: list[dict] = []
    current_pages: list[dict] = []
    current_len = 0

    for page in pages_data:
        p_text = page.get("text", "").strip()
        p_len = len(p_text)

        if current_pages and (current_len + p_len > max_chars_per_unit or len(current_pages) >= max_pages_per_unit):
            units.append(_build_unit(current_pages))
            current_pages = [page]
            current_len = p_len
        else:
            current_pages.append(page)
            current_len += p_len

    if current_pages:
        units.append(_build_unit(current_pages))

    return units


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


def _extract_single_unit(unit: dict, gemini: GeminiRecipeService) -> tuple[list[ExtractedRecipe], list[UnparsedCandidate]]:
    """Extract recipes from a multi-page unit with strict language preservation and attached photos."""
    text = unit.get("text", "").strip()
    page_images = unit.get("page_images", {})
    fallback_img = unit.get("image_data_uri", "")
    raw_pages = unit.get("raw_pages", [])
    if not text:
        return [], []

    # Detect if text is predominantly Hebrew
    hebrew_chars = sum(1 for ch in text if "\u0590" <= ch <= "\u05ff")
    is_hebrew = hebrew_chars >= 15 or (len(text) > 0 and hebrew_chars / len(text) > 0.15)

    lang_instruction = (
        "CRITICAL LANGUAGE RULE: The source text is in HEBREW. "
        "You MUST output title, ingredient names/units/groups, steps, and notes strictly in HEBREW! "
        "Set language='he'. NEVER TRANSLATE TO ENGLISH! Preserve the original Hebrew words verbatim."
        if is_hebrew else
        "Set language='en'."
    )

    prompt = (
        f"{lang_instruction}\n\n"
        f"Always set source='OneNote' and include 'OneNote' in tags.\n"
        f"If '=== PAGE X ===' markers are present, set pageNumber to X (integer) for each recipe.\n\n"
        f"Document text:\n{text}"
    )

    recipes: list[ExtractedRecipe] = []
    unparsed: list[UnparsedCandidate] = []

    # Try up to 2 attempts with a brief pause if rate-limited (429 / 503)
    max_attempts = 2
    for attempt in range(max_attempts):
        try:
            res = gemini.extract_from_onenote_text(prompt)
            items = res.recipes if hasattr(res, "recipes") else (res if isinstance(res, list) else [])
            for r in items:
                # Enforce Hebrew language if text was Hebrew
                if is_hebrew:
                    r.language = "he"
                # Set source to OneNote
                r.source = "OneNote"
                # Add OneNote tag if missing
                if "OneNote" not in (r.tags or []):
                    r.tags = list(r.tags or []) + ["OneNote"]

                # Attach photo from this recipe's page
                assigned_img = ""
                if getattr(r, "pageNumber", None) and r.pageNumber in page_images:
                    assigned_img = page_images[r.pageNumber]
                elif raw_pages:
                    for p in raw_pages:
                        p_t = p.get("text", "")
                        if p.get("image_data_uri") and (r.title in p_t or (len(p_t) > 10 and p_t[:25] in r.title)):
                            assigned_img = p["image_data_uri"]
                            break
                if not assigned_img:
                    assigned_img = fallback_img

                if assigned_img and not r.thumbnailUrl:
                    r.thumbnailUrl = assigned_img

                recipes.append(r)

            if hasattr(res, "unparsed") and res.unparsed:
                unparsed.extend(res.unparsed)
            break
        except Exception as exc:
            err_msg = str(exc)
            if ("429" in err_msg or "RESOURCE_EXHAUSTED" in err_msg or "503" in err_msg) and attempt + 1 < max_attempts:
                time.sleep(3.0)
                continue
            # If extraction failed for this specific unit, preserve as unparsed note so user can manually edit
            first_line = text.splitlines()[0][:60] if text else "OneNote Page"
            unparsed.append(UnparsedCandidate(
                title=first_line,
                reason=f"Extraction error: {err_msg[:100]}",
                rawText=text[:400],
            ))
            break

    return recipes, unparsed


def parse_pdf_onenote_export(
    content: bytes,
    gemini: GeminiRecipeService,
) -> tuple[list[ExtractedRecipe], list[UnparsedCandidate]]:
    """
    Parse a OneNote PDF export page-by-page, extracting images and running units concurrently.
    Ensures that every recipe is extracted, photos are preserved, and language is not translated.
    """
    pages_data = extract_pdf_pages_and_images(content)
    if not pages_data:
        raise UnsupportedFileFormatError(
            "No readable text or images found in this PDF. "
            "Please export your OneNote section as Word (.docx) or Web Page (.html)."
        )

    units = group_pdf_pages_into_units(pages_data)
    if not units:
        return [], []

    all_recipes: list[ExtractedRecipe] = []
    all_unparsed: list[UnparsedCandidate] = []

    # Process units sequentially with rate-limit pacing to respect Gemini quotas and maintain page order
    for idx, unit in enumerate(units):
        try:
            recipes, unparsed = _extract_single_unit(unit, gemini)
            all_recipes.extend(recipes)
            all_unparsed.extend(unparsed)
        except Exception as e:
            first_line = unit.get("text", "").splitlines()[0][:60] if unit.get("text") else "OneNote Page"
            all_unparsed.append(UnparsedCandidate(
                title=first_line,
                reason=f"Unit processing failed: {str(e)[:100]}",
                rawText=unit.get("text", "")[:400],
            ))
        if idx + 1 < len(units):
            time.sleep(0.8)

    return all_recipes, all_unparsed


def parse_onenote_export(
    filename: str,
    content: bytes,
    gemini: GeminiRecipeService,
) -> tuple[list[ExtractedRecipe], list[UnparsedCandidate]]:
    """Extract structured recipes and unparsed candidate notes from an exported OneNote document."""
    ext = Path(filename).suffix.lower()

    if ext == ".pdf":
        return parse_pdf_onenote_export(content, gemini)

    # For DOCX, HTML, TXT, MD
    text = extract_text_from_onenote_bytes(filename, content)
    if not text.strip():
        return [], []

    all_recipes: list[ExtractedRecipe] = []
    all_unparsed: list[UnparsedCandidate] = []

    for chunk in _chunk_text(text):
        hebrew_chars = sum(1 for ch in chunk if "\u0590" <= ch <= "\u05ff")
        is_hebrew = hebrew_chars >= 15 or (len(chunk) > 0 and hebrew_chars / len(chunk) > 0.15)
        lang_instruction = (
            "CRITICAL: The source text is in HEBREW. Output title, ingredients, steps, and notes strictly in HEBREW. "
            "Set language='he'. NEVER translate to English!"
            if is_hebrew else
            "Set language='en'."
        )
        prompt = f"{lang_instruction}\n\nAlways set source='OneNote' and include 'OneNote' in tags.\n\n{chunk}"

        res = gemini.extract_from_onenote_text(prompt)
        items = res.recipes if hasattr(res, "recipes") else (res if isinstance(res, list) else [])
        for r in items:
            if is_hebrew:
                r.language = "he"
            r.source = "OneNote"
            if "OneNote" not in (r.tags or []):
                r.tags = list(r.tags or []) + ["OneNote"]
            all_recipes.append(r)

        if hasattr(res, "unparsed") and res.unparsed:
            all_unparsed.extend(res.unparsed)

    return all_recipes, all_unparsed
