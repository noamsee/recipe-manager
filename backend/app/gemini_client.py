"""Shared Google Gemini client for recipe extraction, OneNote parsing, and translation."""

from pathlib import Path
import time
from typing import TypeVar

from google import genai
from google.genai import types
from pydantic import BaseModel

from .schemas import BatchExtractedRecipes, ExtractedRecipe, LanguageCode

TModel = TypeVar("TModel", bound=BaseModel)

_RECIPE_EXTRACTION_PROMPT = """
You are a culinary data extractor. Extract the complete recipe from the provided content
(video, audio, on-screen text, and/or caption text).

Rules:
- Preserve the recipe's primary language: output 'he' for Hebrew or 'en' for English.
- Keep ingredients, amounts, units, and preparation steps faithful to that language.
- If the content is spoken or shown in video frames, transcribe and structure every ingredient and step clearly.
- Suggest concise category (e.g. Main, Dessert, Salad, Soup, Breakfast, Baking, Side, Drink),
  relevant dietary tags from [meat, dairy, parve, vegan, vegetarian, gluten-free], and 2-6 helpful tags.
- If prep time, cook time, or servings are not stated, return null for those fields.
""".strip()

_ONENOTE_EXTRACTION_PROMPT = """
You are migrating recipes from a Microsoft OneNote export.
Extract ALL distinct recipes found in the provided document text.
Rules:
- Preserve each recipe's original language ('he' for Hebrew, 'en' for English).
- Ignore empty headings, navigation boilerplate, or non-recipe notes unless they are cooking notes belonging to a recipe.
- Suggest category, dietary tags, and helpful tags for each recipe.
""".strip()


VALID_MODELS = (
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro-preview",
)

FALLBACK_MODELS = [
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.1-flash-lite",
    "gemini-3.1-pro-preview",
]


class GeminiRecipeService:
    """Thin wrapper over google-genai for structured recipe operations with multi-model fallback."""

    def __init__(self, api_key: str, model: str = "gemini-3.5-flash") -> None:
        if not api_key:
            raise ValueError("GEMINI_API_KEY is not configured.")
        self._client = genai.Client(api_key=api_key)
        self._model = model if model in VALID_MODELS else "gemini-3.5-flash"

    def _generate_structured(self, contents: list | str, schema: type[TModel]) -> TModel:
        initial_model = self._model if self._model in VALID_MODELS else "gemini-3.5-flash"
        models_to_try = [initial_model] + [m for m in FALLBACK_MODELS if m != initial_model]
        last_error = None
        attempt_log: list[str] = []

        for model_name in models_to_try:
            for attempt in range(2):
                try:
                    response = self._client.models.generate_content(
                        model=model_name,
                        contents=contents,
                        config=types.GenerateContentConfig(
                            response_mime_type="application/json",
                            response_schema=schema,
                            temperature=0.1,
                        ),
                    )
                    if getattr(response, "parsed", None) is not None:
                        return response.parsed  # type: ignore[return-value]
                    if response.text:
                        return schema.model_validate_json(response.text)
                    raise ValueError(f"Model {model_name} returned empty text.")
                except Exception as exc:
                    last_error = exc
                    err_str = str(exc)
                    attempt_log.append(f"{model_name}[att {attempt + 1}]: {err_str[:120]}")
                    # If 503, 429, or UNAVAILABLE temporary spike, wait 1.5s before retry
                    if "503" in err_str or "429" in err_str or "UNAVAILABLE" in err_str or "ResourceExhausted" in err_str:
                        time.sleep(1.5)
                        continue
                    # For other errors (e.g. 404, invalid argument), move to next fallback model
                    break

        raise RuntimeError(
            f"All Gemini models ({', '.join(models_to_try)}) failed. "
            f"Details: [{'; '.join(attempt_log)}]. Last error: {last_error}"
        ) from last_error

    def extract_from_text(
        self,
        text: str,
        source_url: str | None = None,
        extra_context: str = "",
    ) -> ExtractedRecipe:
        """Extract a single structured recipe from caption or raw text."""
        parts = [_RECIPE_EXTRACTION_PROMPT]
        if extra_context.strip():
            parts.append(f"Additional user/chat context:\n{extra_context.strip()}")
        parts.append(f"Source text:\n{text.strip()}")
        recipe = self._generate_structured("\n\n".join(parts), ExtractedRecipe)
        if source_url and not recipe.sourceUrl:
            recipe.sourceUrl = source_url
        return recipe

    def extract_from_media_and_caption(
        self,
        media_path: Path,
        caption: str = "",
        source_url: str | None = None,
        extra_context: str = "",
    ) -> ExtractedRecipe:
        """Upload video/audio to Gemini Files API, extract the recipe, and delete the remote file."""
        uploaded = self._client.files.upload(file=str(media_path))
        try:
            # Video files may enter PROCESSING state briefly before inference.
            deadline = time.monotonic() + 60.0
            while getattr(uploaded, "state", None) and getattr(uploaded.state, "name", "") == "PROCESSING":
                if time.monotonic() > deadline:
                    raise TimeoutError("Timed out waiting for Gemini media processing.")
                time.sleep(1.5)
                uploaded = self._client.files.get(name=uploaded.name)

            if getattr(uploaded, "state", None) and getattr(uploaded.state, "name", "") == "FAILED":
                raise RuntimeError("Gemini failed to process the uploaded Reel media file.")

            prompt_parts = [_RECIPE_EXTRACTION_PROMPT]
            if caption.strip():
                prompt_parts.append(f"Reel caption/description:\n{caption.strip()}")
            if extra_context.strip():
                prompt_parts.append(f"Additional user/chat context:\n{extra_context.strip()}")

            recipe = self._generate_structured([uploaded, "\n\n".join(prompt_parts)], ExtractedRecipe)
            if source_url and not recipe.sourceUrl:
                recipe.sourceUrl = source_url
            return recipe
        finally:
            try:
                self._client.files.delete(name=uploaded.name)
            except Exception:  # noqa: BLE001 - best-effort cleanup of remote temporary file
                pass

    def extract_from_onenote_text(self, document_text: str) -> list[ExtractedRecipe]:
        """Extract one or more structured recipes from an exported OneNote document."""
        prompt = f"{_ONENOTE_EXTRACTION_PROMPT}\n\nDocument text:\n{document_text.strip()}"
        result = self._generate_structured(prompt, BatchExtractedRecipes)
        return result.recipes

    def translate_recipe(self, recipe: ExtractedRecipe, target_language: LanguageCode) -> ExtractedRecipe:
        """Translate a structured recipe into Hebrew ('he') or English ('en')."""
        target_name = "Hebrew" if target_language == "he" else "English"
        prompt = (
            f"Translate the following structured recipe JSON into {target_name} "
            f"(set language='{target_language}'). "
            "Keep measurements, numbers, sourceUrl, thumbnailUrl, prepTimeMinutes, cookTimeMinutes, "
            "servings, and dietary enum values valid. Translate title, ingredient names/units/groups, "
            "steps, category, tags, and notes naturally.\n\n"
            f"{recipe.model_dump_json()}"
        )
        translated = self._generate_structured(prompt, ExtractedRecipe)
        translated.language = target_language
        translated.sourceUrl = recipe.sourceUrl
        translated.thumbnailUrl = recipe.thumbnailUrl
        return translated
