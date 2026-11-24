"""FastAPI entrypoint for Reel extraction, OneNote parsing, and recipe translation."""

from fastapi import Depends, FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .auth import verify_firebase_token
from .config import Settings, load_settings
from .gemini_client import GeminiRecipeService
from .onenote_parser import UnsupportedFileFormatError, parse_onenote_export
from .reel_extractor import (
    ExtractionBlockedError,
    UnsupportedReelUrlError,
    extract_reel_recipe,
)
from .schemas import (
    ExtractedRecipe,
    ExtractReelRequest,
    ExtractReelResponse,
    OneNoteParseResponse,
    ParseTextRequest,
    TranslateRecipeRequest,
)


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create and configure the FastAPI application."""
    resolved_settings = settings or load_settings()

    app = FastAPI(
        title="Recipe Manager Extraction API",
        version="1.0.0",
        description="Bilingual (Hebrew/English) Reel extractor, OneNote parser, and translator.",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def get_settings() -> Settings:
        return resolved_settings

    app.dependency_overrides[load_settings] = get_settings

    def get_gemini(cfg: Settings = Depends(get_settings)) -> GeminiRecipeService:
        if not cfg.gemini_api_key:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="GEMINI_API_KEY is not configured on the server.",
            )
        return GeminiRecipeService(api_key=cfg.gemini_api_key, model=cfg.gemini_model)

    @app.get("/health")
    def health_check() -> dict[str, str]:
        return {"status": "ok"}

    CORS_HEADERS = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
    }

    @app.get("/api/diag")
    def diag_endpoint(cfg: Settings = Depends(get_settings)) -> dict:
        import requests
        import yt_dlp
        from google import genai

        google_certs_ok = False
        try:
            r = requests.get(
                "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com",
                timeout=5,
            )
            google_certs_ok = r.status_code == 200
        except Exception:
            google_certs_ok = False

        available_models = []
        if cfg.gemini_api_key:
            try:
                client = genai.Client(api_key=cfg.gemini_api_key)
                for m in client.models.list():
                    name = getattr(m, "name", str(m))
                    methods = getattr(m, "supported_generation_methods", []) or getattr(m, "supported_actions", [])
                    available_models.append({"name": name, "methods": methods})
            except Exception as e:
                available_models = [{"error": f"{type(e).__name__}: {e}"}]

        return {
            "status": "ok",
            "firebaseProjectIdConfigured": bool(cfg.firebase_project_id),
            "firebaseProjectId": cfg.firebase_project_id,
            "geminiApiKeyConfigured": bool(cfg.gemini_api_key),
            "configuredModel": cfg.gemini_model,
            "googleCertsReachable": google_certs_ok,
            "availableModels": available_models[:15],
            "ytDlpVersion": yt_dlp.version.__version__,
        }

    @app.get("/api/test-models")
    def test_models_endpoint(
        cfg: Settings = Depends(get_settings),
        gemini: GeminiRecipeService = Depends(get_gemini),
    ) -> dict:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=cfg.gemini_api_key)
        candidates = [
            "gemini-3.5-flash-lite",
            "gemini-3.1-flash-lite",
            "gemini-3.5-flash",
            "gemini-3.6-flash",
            "gemma-4-26b-a4b-it",
            "gemma-4-31b-it",
            "gemini-omni-flash-preview",
        ]
        results = {}
        for m in candidates:
            try:
                resp = client.models.generate_content(
                    model=m,
                    contents="Say 'OK' in JSON format: {\"status\": \"OK\"}",
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        temperature=0.1,
                    ),
                )
                results[m] = {"status": "ok", "text": resp.text[:100]}
            except Exception as e:
                results[m] = {"status": "error", "error": str(e)[:200]}

        # Also test structured recipe extraction with the configured service
        structured_test = {}
        try:
            r = gemini.extract_from_text("Salad: 1 cucumber, 2 tomatoes, olive oil, salt. Chop and mix.")
            structured_test = {"status": "ok", "title": r.title, "ingredientsCount": len(r.ingredients)}
        except Exception as e:
            structured_test = {"status": "error", "error": str(e)[:300]}

        return {
            "configuredModel": cfg.gemini_model,
            "structuredTest": structured_test,
            "models": results,
        }

    @app.exception_handler(HTTPException)
    async def custom_http_exception_handler(_request, exc: HTTPException):
        return JSONResponse(
            status_code=exc.status_code,
            headers=CORS_HEADERS,
            content={"detail": exc.detail},
        )

    @app.exception_handler(Exception)
    async def global_exception_handler(_request, exc: Exception):
        import traceback
        tb = traceback.format_exc()
        return JSONResponse(
            status_code=500,
            headers=CORS_HEADERS,
            content={
                "detail": f"{type(exc).__name__}: {exc}",
                "type": type(exc).__name__,
                "traceback": tb,
            },
        )

    @app.post("/api/extract-reel", response_model=ExtractReelResponse)
    def extract_reel_endpoint(
        payload: ExtractReelRequest,
        _claims: dict = Depends(verify_firebase_token),
        cfg: Settings = Depends(get_settings),
        gemini: GeminiRecipeService = Depends(get_gemini),
    ) -> ExtractReelResponse:
        try:
            recipe = extract_reel_recipe(
                url=str(payload.url),
                gemini=gemini,
                extra_context=payload.extraContext,
                max_filesize_mb=cfg.max_reel_filesize_mb,
            )
            return ExtractReelResponse(status="ok", recipe=recipe)
        except UnsupportedReelUrlError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        except ExtractionBlockedError as exc:
            return ExtractReelResponse(
                status="blocked_fallback_required",
                message=str(exc),
                rawCaption=exc.raw_caption,
            )

    @app.post("/api/parse-text", response_model=ExtractedRecipe)
    def parse_text_endpoint(
        payload: ParseTextRequest,
        _claims: dict = Depends(verify_firebase_token),
        gemini: GeminiRecipeService = Depends(get_gemini),
    ) -> ExtractedRecipe:
        return gemini.extract_from_text(
            text=payload.text,
            source_url=payload.sourceUrl,
        )

    @app.post("/api/parse-onenote", response_model=OneNoteParseResponse)
    async def parse_onenote_endpoint(
        file: UploadFile = File(...),
        _claims: dict = Depends(verify_firebase_token),
        gemini: GeminiRecipeService = Depends(get_gemini),
        cfg: Settings = Depends(get_settings),
    ) -> OneNoteParseResponse:
        filename = file.filename or "onenote_export.txt"
        raw_bytes = await file.read()
        max_mb = cfg.max_onenote_filesize_mb
        if len(raw_bytes) > max_mb * 1024 * 1024:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=f"Uploaded file exceeds {max_mb} MB limit.",
            )
        try:
            recipes, unparsed = parse_onenote_export(filename=filename, content=raw_bytes, gemini=gemini)
        except (UnsupportedFileFormatError, ValueError) as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        return OneNoteParseResponse(filename=filename, recipes=recipes, unparsed=unparsed)

    @app.post("/api/translate", response_model=ExtractedRecipe)
    def translate_endpoint(
        payload: TranslateRecipeRequest,
        _claims: dict = Depends(verify_firebase_token),
        gemini: GeminiRecipeService = Depends(get_gemini),
    ) -> ExtractedRecipe:
        return gemini.translate_recipe(
            recipe=payload.recipe,
            target_language=payload.targetLanguage,
        )

    return app


app = create_app()
