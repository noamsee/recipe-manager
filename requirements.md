# Recipe Manager App — Finalized Requirements

## 1. Overview & Purpose
A personal, mobile-friendly Recipe Manager web application replacing a Microsoft OneNote recipe notebook and a WhatsApp group full of Facebook and Instagram Reel links. Accessible anywhere (desktop and phone, including at the supermarket) using a 100% free-tier architecture.

## 2. System Architecture & Tech Stack
- **Frontend:** Vanilla HTML5, modern CSS3, and Vanilla JavaScript hosted on **GitHub Pages** (responsive mobile-first design, English UI).
- **Database, Auth & Media:** **Google Firebase** (Spark free tier):
  - **Firebase Auth:** Private account login (Google Sign-In and/or email/password).
  - **Cloud Firestore:** Persistent storage for recipes, tags, notes/ratings, shopping lists, and share tokens.
  - **Media Storage:** Recipe photo and Reel thumbnail storage (Firebase Storage or compressed thumbnail storage).
- **Extraction & AI Service:** Lightweight **Python FastAPI** backend hosted on **Render** (free tier):
  - **`yt-dlp` + `ffmpeg`:** Fetches Reel metadata/captions and audio/video streams from Facebook and Instagram URLs.
  - **Google Gemini API (free tier):** Multimodal extraction (Hebrew/English audio, video frames, captions) into structured recipe JSON, auto-tagging, OneNote import parsing, and on-demand translation.

## 3. Functional Requirements

### 3.1 Reel Extraction & Batch / WhatsApp Import
- **Single-URL Hybrid Extraction:**
  - Accept a Facebook or Instagram Reel URL, fetch caption + audio/video via `yt-dlp`, and extract structured recipe data via Gemini.
  - Provide an instant **manual caption/text paste fallback** if Meta blocks cloud scraping for a given link.
  - Store the original Reel URL alongside the recipe.
- **Batch Reel Importer:**
  - Support pasting multiple Reel URLs at once and processing them in a queue.
  - **WhatsApp `.txt` Parser:** Support uploading a WhatsApp *"Export Chat (Without Media)"* `.txt` file to automatically extract all Facebook/Instagram Reel URLs and surrounding message notes into the batch queue.
- **Auto-Tagging:** Gemini automatically suggests categories, prep/cook time, and dietary tags (e.g., Dessert, Pasta, Vegan, Meat/Dairy/Parve) during extraction.

### 3.2 Microsoft OneNote Migration
- **One-Time Bulk Importer:** Accept exported OneNote files (HTML, Word `.docx`, or PDF) and parse them via Gemini into structured recipe records for import into Firestore.

### 3.3 Bilingual Support (Hebrew & English)
- **App Interface:** English UI for navigation, buttons, and settings.
- **Recipe Content:** Preserve each recipe in its original language (Hebrew or English) with automatic per-recipe / per-field RTL (Hebrew) and LTR (English) rendering.
- **On-Demand Translation:** Optional button on each recipe to translate between Hebrew and English via Gemini.

### 3.4 Recipe Management & Cooking Workflow (MVP)
- **Recipe CRUD & Organization:** Create, view, edit, and delete recipes; full-text search; filter by tags/categories; personal notes and 1–5 star ratings.
- **Cook Mode:** Interactive checkable ingredient and step lists, plus Screen Wake Lock API to keep the phone screen awake while cooking.
- **Supermarket Shopping List:** Add ingredients from one or more recipes into a unified, checkable shopping list persisted in Firestore.
- **Shareable Read-Only Links:** Generate a read-only share link for individual recipes so friends/family can view a recipe without signing in.
- **Backup & Portability:** One-click export of all recipes as JSON and Markdown.

## 4. Security & Privacy
- Firestore security rules restrict read/write access to authenticated household user(s), except for explicitly shared read-only recipe documents/tokens.
- Gemini API key is stored securely as an environment variable on the Render backend (never exposed in the GitHub Pages frontend).

## 5. Known Operational Constraints
- **Render Free Tier Cold Starts:** The Render backend spins down after ~15 minutes of inactivity; the first Reel extraction or translation after idle takes ~30–50 seconds to wake up.
- **Meta Anti-Scraping:** Some Reels may require the manual caption-paste fallback if Instagram/Facebook enforces a login wall on the server IP.
