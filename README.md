# Recipe Manager

Bilingual (**Hebrew RTL & English LTR**) personal Recipe Manager web app designed for a 100% free-tier stack:

- **Frontend:** Vanilla HTML5, CSS3, and ES Modules JS deployed on **GitHub Pages** (`frontend/`).
- **Database & Auth:** **Google Firebase** Spark free tier (Firebase Auth + Cloud Firestore + `firestore.rules`).
- **Reel Extraction & AI:** **Python FastAPI + `yt-dlp` + `ffmpeg` + Google Gemini (`gemini-2.5-flash`)** deployed via Docker on **Render** (`backend/`).

## Features
- **Reel Extraction (Facebook & Instagram):** Downloads Reel media/caption via `yt-dlp` and extracts structured bilingual recipes via Gemini, with a manual caption-paste fallback if Meta blocks a link.
- **Batch & WhatsApp Importer:** Upload a WhatsApp *"Export Chat (Without Media)"* `.txt` file or paste multiple Reel URLs to extract in a deduplicated queue.
- **OneNote Bulk Import:** Upload exported OneNote `.html`, `.docx`, or `.pdf` files to parse existing recipes via Gemini.
- **Bilingual RTL/LTR & Translation:** Automatic Hebrew (`rtl`) / English (`ltr`) detection per recipe plus an on-demand **Translate HE ↔ EN** button.
- **Cook Mode & Supermarket List:** Screen Wake Lock API, checkable ingredients/steps, Firestore shopping list, compressed thumbnails, ratings/notes, read-only public share links (`share.html`), and JSON/Markdown export.

---

## Setup & Deployment

### 1. Firebase (Spark Free Tier)
1. Create a project in [Firebase Console](https://console.firebase.google.com/).
2. Enable **Authentication** → Sign-in methods: **Google** and **Email/Password**.
3. Enable **Cloud Firestore** and publish the security rules from `firestore.rules`.
4. Register a **Web App** in Project Settings and copy the `firebaseConfig` object into `frontend/js/config.js` (`DEFAULT_FIREBASE_CONFIG`), or paste it in the first-run setup screen.
5. In Firebase Authentication → Settings → Authorized domains, add `noamsee.github.io`.

### 2. Render Backend (Free Tier Docker)
1. Create a free Web Service on [Render](https://render.com/) connected to `noamsee/recipe-manager`, with Root Directory set to `backend` (or deploy via `backend/render.yaml`).
2. Set environment variables on Render:
   - `GEMINI_API_KEY`: Your API key from [Google AI Studio](https://aistudio.google.com/).
   - `FIREBASE_PROJECT_ID`: Your Firebase `projectId`.
   - `ALLOWED_ORIGINS`: `https://noamsee.github.io`
3. Copy your Render URL (e.g. `https://recipe-manager-api.onrender.com`) into `frontend/js/config.js` (`DEFAULT_API_URL`) or Settings inside the app.

### 3. GitHub Pages
1. In your GitHub repo: **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **Deploy from a branch**.
3. Under **Branch**, select `main` and `/ (root)`, then click **Save**.
4. Your site will be live at `https://noamsee.github.io/recipe-manager/`.

---

## Local Development & Tests

```powershell
# Frontend unit tests (Node 24+)
node --test frontend_tests/*.test.mjs

# Backend unit tests (Python 3.12+)
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
pytest tests
```
