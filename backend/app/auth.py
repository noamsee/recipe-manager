"""Firebase ID token verification dependency for FastAPI routes."""

from fastapi import Depends, Header, HTTPException, status
from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

from .config import Settings, load_settings

_HTTP_REQUEST = google_requests.Request()


def verify_firebase_token(
    authorization: str | None = Header(default=None),
    settings: Settings = Depends(load_settings),
) -> dict:
    """Validate the Bearer Firebase ID token and return decoded claims."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or invalid Authorization Bearer token.",
        )

    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Empty bearer token.",
        )

    if settings.allow_unauthenticated_local and not settings.firebase_project_id:
        return {"uid": "local-dev-user", "email": "local@example.com"}

    if not settings.firebase_project_id:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="FIREBASE_PROJECT_ID is not configured on the server.",
        )

    try:
        claims = id_token.verify_firebase_token(
            token,
            _HTTP_REQUEST,
            audience=settings.firebase_project_id,
        )
    except Exception as exc:  # noqa: BLE001 - google-auth raises ValueError/TransportError
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid Firebase ID token: {exc}",
        ) from exc

    if not claims or not claims.get("sub"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token missing subject claim.",
        )
    return claims
