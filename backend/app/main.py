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

    @app.get("/api/diag")
    def diag_endpoint(cfg: Settings = Depends(get_settings)) -> dict:
        import requests
        import yt_dlp

        google_certs_ok = False
        try:
            r = requests.get(
                "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com",
                timeout=5,
            )
            google_certs_ok = r.status_code == 200
        except Exception:
            google_certs_ok = False

        gemini_ping_ok = False
        gemini_error = ""
        if cfg.gemini_api_key:
            try:
                svc = GeminiRecipeService(api_key=cfg.gemini_api_key, model=cfg.gemini_model)
                test_recipe = svc.extract_from_text("2 eggs and 1 tbsp butter, scramble in a pan")
                gemini_ping_ok = bool(test_recipe and test_recipe.title)
            except Exception as e:
                gemini_error = f"{type(e).__name__}: {e}"

        return {
            "status": "ok",
            "firebaseProjectIdConfigured": bool(cfg.firebase_project_id),
            "firebaseProjectId": cfg.firebase_project_id,
            "geminiApiKeyConfigured": bool(cfg.gemini_api_key),
            "geminiModel": cfg.gemini_model,
            "googleCertsReachable": google_certs_ok,
            "geminiPingOk": gemini_ping_ok,
            "geminiError": gemini_error,
            "ytDlpVersion": yt_dlp.version.__version__,
        }

    @app.exception_handler(Exception)
    async def global_exception_handler(_request, exc: Exception):
        import traceback
        tb = traceback.format_exc()
        return JSONResponse(
            status_code=500,
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
    ) -> OneNoteParseResponse:
        filename = file.filename or "onenote_export.txt"
        raw_bytes = await file.read()
        if len(raw_bytes) > 15 * 1024 * 1024:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="Uploaded file exceeds 15 MB limit.",
            )
        try:
            recipes = parse_onenote_export(filename=filename, content=raw_bytes, gemini=gemini)
        except UnsupportedFileFormatError as exc:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
        return OneNoteParseResponse(filename=filename, recipes=recipes)

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
