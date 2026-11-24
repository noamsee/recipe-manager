"""Pydantic schemas for recipe extraction, translation, and API payloads."""

from typing import Literal
from pydantic import BaseModel, Field, HttpUrl


DietaryTag = Literal["meat", "dairy", "parve", "vegan", "vegetarian", "gluten-free"]
LanguageCode = Literal["he", "en"]


class IngredientItem(BaseModel):
    """Structured ingredient entry."""

    name: str = Field(..., min_length=1, description="Ingredient name in the recipe's language.")
    amount: str = Field(default="", description="Quantity or range (e.g. '2', '1/2', '200').")
    unit: str = Field(default="", description="Measurement unit (e.g. 'cups', 'g', 'כפות').")
    group: str = Field(default="", description="Optional sub-section (e.g. 'For the sauce').")


class ExtractedRecipe(BaseModel):
    """Structured recipe representation returned by AI extraction and translation."""

    title: str = Field(..., min_length=1)
    language: LanguageCode = "en"
    ingredients: list[IngredientItem] = Field(default_factory=list)
    steps: list[str] = Field(default_factory=list)
    prepTimeMinutes: int | None = None
    cookTimeMinutes: int | None = None
    servings: int | None = None
    category: str = Field(default="Other")
    dietary: list[DietaryTag] = Field(default_factory=list)
    tags: list[str] = Field(default_factory=list)
    notes: str = Field(default="")
    sourceUrl: str | None = None
    thumbnailUrl: str | None = None
    source: str = Field(default="Manual")


class UnparsedCandidate(BaseModel):
    """A recipe candidate or section in the OneNote document that could not be fully structured."""

    title: str = Field(default="Untitled note", description="Title or heading of the incomplete section.")
    reason: str = Field(default="Incomplete recipe details", description="Reason why it could not be structured automatically.")
    rawText: str = Field(default="", description="The raw text snippet so the user can review and edit it manually.")


class BatchExtractedRecipes(BaseModel):
    """Container schema used when parsing OneNote documents containing multiple recipes."""

    recipes: list[ExtractedRecipe] = Field(default_factory=list)
    unparsed: list[UnparsedCandidate] = Field(default_factory=list)


class ExtractReelRequest(BaseModel):
    """Request body for extracting a recipe from a Facebook or Instagram Reel URL."""

    url: HttpUrl
    extraContext: str = Field(default="", description="Optional note from WhatsApp or user.")


class ExtractReelResponse(BaseModel):
    """Response returned by /api/extract-reel."""

    status: Literal["ok", "blocked_fallback_required"]
    recipe: ExtractedRecipe | None = None
    message: str = ""
    rawCaption: str = ""


class ParseTextRequest(BaseModel):
    """Request body for extracting a recipe from pasted caption or raw text."""

    text: str = Field(..., min_length=5)
    sourceUrl: str | None = None


class TranslateRecipeRequest(BaseModel):
    """Request body for translating a structured recipe between Hebrew and English."""

    recipe: ExtractedRecipe
    targetLanguage: LanguageCode


class OneNoteParseResponse(BaseModel):
    """Response returned by /api/parse-onenote."""

    filename: str
    recipes: list[ExtractedRecipe] = Field(default_factory=list)
    unparsed: list[UnparsedCandidate] = Field(default_factory=list)
