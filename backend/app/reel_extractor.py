"""Facebook and Instagram Reel downloader and recipe extractor."""

import base64
from pathlib import Path
import tempfile
from urllib.parse import urlparse

import requests
import yt_dlp

from .gemini_client import GeminiRecipeService
from .schemas import ExtractedRecipe

ALLOWED_REEL_HOSTS = {
    "instagram.com",
    "www.instagram.com",
    "m.instagram.com",
    "facebook.com",
    "www.facebook.com",
    "m.facebook.com",
    "fb.watch",
    "l.facebook.com",
}

_BLOCKED_INDICATORS = (
    "login",
    "logged-in",
    "cookies",
    "rate-limit",
    "http error 401",
    "http error 403",
    "http error 429",
    "checkpoint",
    "empty media response",
    "unable to extract",
    "not available",
    "private",
)


class UnsupportedReelUrlError(ValueError):
    """Raised when the provided URL is not a supported Facebook or Instagram link."""


class ExtractionBlockedError(RuntimeError):
    """Raised when Meta blocks unauthenticated Reel retrieval and manual paste is needed."""

    def __init__(self, message: str, raw_caption: str = "") -> None:
        super().__init__(message)
        self.raw_caption = raw_caption


def validate_reel_url(url: str) -> str:
    """Validate that the URL targets a supported Facebook or Instagram domain."""
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if parsed.scheme not in {"http", "https"} or host not in ALLOWED_REEL_HOSTS:
        raise UnsupportedReelUrlError(
            "Only Facebook (facebook.com, fb.watch) and Instagram (instagram.com) URLs are supported."
        )
    return url


def _is_blocked_error(exc_text: str) -> bool:
    lowered = exc_text.lower()
    return any(marker in lowered for marker in _BLOCKED_INDICATORS)


_RECIPE_INDICATORS = (
    "ingredient",
    "procedure",
    "instruction",
    "recipe",
    "cup",
    "tbsp",
    "tsp",
    "bake",
    "blend",
    "cook",
    "מצרכים",
    "אופן",
    "הכנה",
    "כוס",
    "כף",
    "כפיות",
    "גרם",
    "לתנור",
    "דקות",
    "מעלות",
)


def _caption_has_recipe_content(caption: str) -> bool:
    """Check if the caption contains enough text or culinary markers to extract without video."""
    if len(caption) >= 100:
        return True
    lowered = caption.lower()
    return any(word in lowered for word in _RECIPE_INDICATORS)


def _fetch_thumbnail_data_uri(thumbnail_url: str | None) -> str | None:
    """Fetch remote thumbnail into a data URI so expiring Meta CDN links do not break later."""
    if not thumbnail_url:
        return None
    try:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            )
        }
        resp = requests.get(thumbnail_url, headers=headers, timeout=6)
        if resp.status_code == 200 and len(resp.content) <= 500_000:
            content_type = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
            if content_type.startswith("image/"):
                encoded = base64.b64encode(resp.content).decode("ascii")
                return f"data:{content_type};base64,{encoded}"
    except Exception:  # noqa: BLE001 - thumbnail caching is best-effort
        return None
    return None


def _find_downloaded_media(directory: Path) -> Path | None:
    """Locate the downloaded video or audio file inside the temp directory."""
    candidates = [
        p
        for p in directory.iterdir()
        if p.is_file() and p.suffix.lower() in {".mp4", ".mov", ".mkv", ".webm", ".m4a", ".mp3"}
    ]
    return candidates[0] if candidates else None


def extract_reel_recipe(
    url: str,
    gemini: GeminiRecipeService,
    extra_context: str = "",
    max_filesize_mb: int = 25,
) -> ExtractedRecipe:
    """Extract a structured recipe from a Reel, prioritizing fast metadata/caption extraction."""
    validated_url = validate_reel_url(url)

    # 1. Fast metadata-first extraction (avoids downloading huge video when caption has the recipe)
    fast_opts = {
        "skip_download": True,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "socket_timeout": 15,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
        },
    }

    try:
        with yt_dlp.YoutubeDL(fast_opts) as ydl:
            info = ydl.extract_info(validated_url, download=False)
    except Exception as exc:
        err_msg = str(exc)
        if _is_blocked_error(err_msg):
            raise ExtractionBlockedError(
                "Instagram/Facebook blocked automatic access to this Reel. "
                "Please paste the Reel caption or text below to extract the recipe."
            ) from exc
        raise ExtractionBlockedError(
            f"Could not read Reel metadata ({err_msg}). You can paste the caption manually."
        ) from exc

    if not info:
        raise ExtractionBlockedError(
            "No media metadata returned by Instagram/Facebook. Paste the caption manually."
        )

    caption = (info.get("description") or info.get("title") or "").strip()
    thumbnail_data_uri = _fetch_thumbnail_data_uri(info.get("thumbnail"))

    # If the caption has recipe content, extract directly in seconds without heavy video download!
    if caption and _caption_has_recipe_content(caption):
        recipe = gemini.extract_from_text(
            text=caption,
            source_url=validated_url,
            extra_context=extra_context,
        )
        recipe.sourceUrl = validated_url
        if thumbnail_data_uri and not recipe.thumbnailUrl:
            recipe.thumbnailUrl = thumbnail_data_uri
        return recipe

    # 2. If caption was minimal, download video/audio stream with conservative limits
    with tempfile.TemporaryDirectory(prefix="reel_") as tmp_dir:
        tmp_path = Path(tmp_dir)
        ydl_opts = {
            "outtmpl": str(tmp_path / "media.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "max_filesize": min(max_filesize_mb, 15) * 1024 * 1024,
            "format": "mp4/best[ext=mp4]/bestvideo[ext=mp4]+bestaudio/best",
            "merge_output_format": "mp4",
            "socket_timeout": 20,
        }

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(validated_url, download=True)
        except Exception as exc:
            err_msg = str(exc)
            if _is_blocked_error(err_msg):
                raise ExtractionBlockedError(
                    "Instagram/Facebook blocked video download for this Reel. "
                    "Please paste the caption or text manually.",
                    raw_caption=caption,
                ) from exc
            raise ExtractionBlockedError(
                f"Could not download Reel video ({err_msg}). Paste the recipe manually.",
                raw_caption=caption,
            ) from exc

        media_file = _find_downloaded_media(tmp_path)
        if media_file and media_file.stat().st_size > 0:
            recipe = gemini.extract_from_media_and_caption(
                media_path=media_file,
                caption=caption,
                source_url=validated_url,
                extra_context=extra_context,
            )
        elif caption:
            recipe = gemini.extract_from_text(
                text=caption,
                source_url=validated_url,
                extra_context=extra_context,
            )
        else:
            raise ExtractionBlockedError(
                "Reel has no caption or usable media. Paste the recipe text manually.",
                raw_caption=caption,
            )

        recipe.sourceUrl = validated_url
        if thumbnail_data_uri and not recipe.thumbnailUrl:
            recipe.thumbnailUrl = thumbnail_data_uri
        return recipe
