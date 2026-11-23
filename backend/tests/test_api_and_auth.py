"""Unit tests for FastAPI endpoints, auth guard, and Reel fallback behavior."""

from fastapi.testclient import TestClient

from app.auth import verify_firebase_token
from app.config import Settings
from app.main import create_app
from app.reel_extractor import ExtractionBlockedError, validate_reel_url
from app.schemas import ExtractedRecipe, IngredientItem


class _FakeGeminiService:
    def extract_from_text(self, text: str, source_url: str | None = None, extra_context: str = "") -> ExtractedRecipe:
        return ExtractedRecipe(
            title="פסטה שום ושמן זית",
            language="he",
            ingredients=[IngredientItem(name="פסטה", amount="250", unit="גרם")],
            steps=["מבשלים פסטה", "מטגנים שום"],
            category="Main",
            dietary=["parve", "vegan"],
            tags=["pasta", "quick"],
            sourceUrl=source_url,
        )

    def extract_from_onenote_text(self, document_text: str) -> list[ExtractedRecipe]:
        return [self.extract_from_text(document_text)]

    def translate_recipe(self, recipe: ExtractedRecipe, target_language: str) -> ExtractedRecipe:
        return ExtractedRecipe(
            title="Garlic Olive Oil Pasta",
            language=target_language,  # type: ignore[arg-type]
            ingredients=[IngredientItem(name="Pasta", amount="250", unit="g")],
            steps=["Boil pasta", "Saute garlic"],
            category=recipe.category,
            dietary=recipe.dietary,
            tags=recipe.tags,
            sourceUrl=recipe.sourceUrl,
        )


def _test_settings() -> Settings:
    return Settings(
        gemini_api_key="test-key",
        firebase_project_id="test-project",
        gemini_model="gemini-3.5-flash",
        allowed_origins=["https://noamsee.github.io"],
        allow_unauthenticated_local=False,
    )


def test_health_endpoint_is_public() -> None:
    app = create_app(_test_settings())
    client = TestClient(app)
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"status": "ok"}


def test_protected_endpoint_requires_bearer_token() -> None:
    app = create_app(_test_settings())
    client = TestClient(app)
    resp = client.post("/api/parse-text", json={"text": "2 eggs and butter"})
    assert resp.status_code == 401


def test_validate_reel_url_allows_meta_and_rejects_others() -> None:
    assert validate_reel_url("https://www.instagram.com/reel/ABC123/")
    assert validate_reel_url("https://fb.watch/xyz/")
    try:
        validate_reel_url("https://evil.example.com/reel/1")
    except ValueError as exc:
        assert "Facebook" in str(exc)
    else:
        raise AssertionError("Expected UnsupportedReelUrlError")


def test_extract_reel_returns_blocked_fallback(monkeypatch) -> None:
    app = create_app(_test_settings())
    app.dependency_overrides[verify_firebase_token] = lambda: {"sub": "user-1"}
    # Replace get_gemini dependency via monkeypatching GeminiRecipeService
    monkeypatch.setattr("app.main.GeminiRecipeService", lambda **kwargs: _FakeGeminiService())

    def _raise_blocked(*args, **kwargs):
        raise ExtractionBlockedError("Blocked by Instagram login wall")

    monkeypatch.setattr("app.main.extract_reel_recipe", _raise_blocked)

    client = TestClient(app)
    resp = client.post(
        "/api/extract-reel",
        json={"url": "https://www.instagram.com/reel/C123456/"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "blocked_fallback_required"
    assert "Instagram" in data["message"]


def test_extract_reel_rejects_non_meta_host(monkeypatch) -> None:
    app = create_app(_test_settings())
    app.dependency_overrides[verify_firebase_token] = lambda: {"sub": "user-1"}
    monkeypatch.setattr("app.main.GeminiRecipeService", lambda **kwargs: _FakeGeminiService())

    client = TestClient(app)
    resp = client.post(
        "/api/extract-reel",
        json={"url": "https://youtube.com/watch?v=123"},
    )
    assert resp.status_code == 400


def test_parse_text_and_translate_and_onenote(monkeypatch) -> None:
    app = create_app(_test_settings())
    app.dependency_overrides[verify_firebase_token] = lambda: {"sub": "user-1"}
    monkeypatch.setattr("app.main.GeminiRecipeService", lambda **kwargs: _FakeGeminiService())

    client = TestClient(app)

    parsed = client.post("/api/parse-text", json={"text": "250 גרם פסטה ושום"})
    assert parsed.status_code == 200
    recipe_json = parsed.json()
    assert recipe_json["language"] == "he"
    assert recipe_json["title"] == "פסטה שום ושמן זית"

    translated = client.post(
        "/api/translate",
        json={"recipe": recipe_json, "targetLanguage": "en"},
    )
    assert translated.status_code == 200
    assert translated.json()["language"] == "en"
    assert translated.json()["title"] == "Garlic Olive Oil Pasta"

    onenote = client.post(
        "/api/parse-onenote",
        files={"file": ("recipes.html", b"<html><body><p>Pasta</p></body></html>", "text/html")},
    )
    assert onenote.status_code == 200
    assert len(onenote.json()["recipes"]) == 1

    bad_onenote = client.post(
        "/api/parse-onenote",
        files={"file": ("bad.exe", b"binary", "application/octet-stream")},
    )
    assert bad_onenote.status_code == 400
