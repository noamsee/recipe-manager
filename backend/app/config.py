"""Application configuration loaded from environment variables."""

from dataclasses import dataclass
import os


@dataclass(frozen=True)
class Settings:
    """Runtime settings for the FastAPI extraction service."""

    gemini_api_key: str
    firebase_project_id: str
    gemini_model: str
    allowed_origins: list[str]
    allow_unauthenticated_local: bool
    max_reel_filesize_mb: int = 25


def load_settings() -> Settings:
    """Build Settings from the current process environment."""
    raw_origins = os.getenv("ALLOWED_ORIGINS", "https://noamsee.github.io")
    origins = [origin.strip().rstrip("/") for origin in raw_origins.split(",") if origin.strip()]
    model = os.getenv("GEMINI_MODEL", "gemini-3.5-flash").strip()
    if not model or any(dep in model for dep in ["3.8", "2.5", "2.0", "1.5"]):
        model = "gemini-3.5-flash"
    return Settings(
        gemini_api_key=os.getenv("GEMINI_API_KEY", "").strip(),
        firebase_project_id=os.getenv("FIREBASE_PROJECT_ID", "").strip(),
        gemini_model=model,
        allowed_origins=origins or ["*"],
        allow_unauthenticated_local=os.getenv("ALLOW_UNAUTHENTICATED_LOCAL", "false").lower() == "true",
    )
