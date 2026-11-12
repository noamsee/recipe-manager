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


def _fetch_thumbnail_data_uri(thumbnail_url: str | None) -> str | None:
    """Fetch remote thumbnail into a data URI so expiring Meta CDN links do not break later."""
    if not thumbnail_url:
        return None
    try:
        resp = requests.get(thumbnail_url, timeout=8)
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
    """Download a Reel with yt-dlp and extract a structured recipe via Gemini."""
    validated_url = validate_reel_url(url)

    with tempfile.TemporaryDirectory(prefix="reel_") as tmp_dir:
        tmp_path = Path(tmp_dir)
        ydl_opts = {
            "outtmpl": str(tmp_path / "media.%(ext)s"),
            "noplaylist": True,
            "quiet": True,
            "no_warnings": True,
            "max_filesize": max_filesize_mb * 1024 * 1024,
            "format": "mp4/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best",
            "merge_output_format": "mp4",
            "socket_timeout": 15,
        }

        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(validated_url, download=True)
        except Exception as exc:
            err_msg = str(exc)
            if _is_blocked_error(err_msg):
                raise ExtractionBlockedError(
                    "Instagram/Facebook blocked automatic access to this Reel. "
                    "Please paste the Reel caption or text below to extract the recipe."
                ) from exc
            raise ExtractionBlockedError(
                f"Could not download Reel automatically ({err_msg}). "
                "You can paste the Reel caption/text manually."
            ) from exc

        if not info:
            raise ExtractionBlockedError(
                "No media metadata returned by Instagram/Facebook. Paste the caption manually."
            )

        caption = (info.get("description") or info.get("title") or "").strip()
        thumbnail_data_uri = _fetch_thumbnail_data_uri(info.get("thumbnail"))
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
                "Reel downloaded without usable media or caption text. Paste the recipe text manually.",
                raw_caption=caption,
            )

        recipe.sourceUrl = validated_url
        if thumbnail_data_uri and not recipe.thumbnailUrl:
            recipe.thumbnailUrl = thumbnail_data_uri
        return recipe
