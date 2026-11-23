"""Generate high-resolution icons, favicons, and Open Graph social preview images for Recipe Manager."""

import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from bidi.algorithm import get_display

def fix_hebrew(text: str) -> str:
    """Properly shape bidirectional Hebrew text for Pillow rendering."""
    try:
        return get_display(text)
    except Exception:
        return text

ASSETS_DIR = Path("assets")
ASSETS_DIR.mkdir(parents=True, exist_ok=True)

# Colors matching the Recipe Manager theme
TERRACOTTA = (196, 75, 43)        # #C44B2B
DARK_TERRACOTTA = (168, 56, 28)   # #A8381C
WARM_GOLD = (235, 178, 80)        # #EBB250
CREAM = (253, 248, 244)           # #FDF8F4
DARK_SLATE = (45, 35, 30)         # #2D231E
MUTED_SLATE = (110, 95, 88)       # #6E5F58
WHITE = (255, 255, 255)
HERB_GREEN = (78, 142, 94)        # #4E8E5E

def create_app_icon(size: int = 512) -> Image.Image:
    """Create a high-resolution rounded squircle app icon."""
    scale = 4  # 4x supersampling for ultra-crisp edges
    w = size * scale
    h = size * scale

    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 1. Background Rounded Squircle with vertical gradient
    pad = int(w * 0.04)
    radius = int(w * 0.22)
    bg_box = [pad, pad, w - pad, h - pad]

    # Draw rounded background
    for y in range(pad, h - pad):
        factor = (y - pad) / (h - 2 * pad)
        r = int(TERRACOTTA[0] * (1 - factor) + DARK_TERRACOTTA[0] * factor)
        g = int(TERRACOTTA[1] * (1 - factor) + DARK_TERRACOTTA[1] * factor)
        b = int(TERRACOTTA[2] * (1 - factor) + DARK_TERRACOTTA[2] * factor)
        draw.line([(pad, y), (w - pad, y)], fill=(r, g, b, 255), width=1)

    # Mask to rounded rectangle
    mask = Image.new("L", (w, h), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle(bg_box, radius=radius, fill=255)

    icon_bg = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    icon_bg.paste(img, (0, 0), mask)
    draw = ImageDraw.Draw(icon_bg)

    # Subtle inner border for polish
    draw.rounded_rectangle(bg_box, radius=radius, outline=(255, 255, 255, 50), width=int(scale * 3))

    cx = w // 2
    cy = int(h * 0.58)

    # 2. Steam & Culinary Leaf
    # Left steam curl
    steam_y = int(h * 0.28)
    draw.arc([cx - int(w * 0.22), steam_y - int(h * 0.08), cx - int(w * 0.02), steam_y + int(h * 0.12)],
             start=200, end=360, fill=(255, 255, 255, 200), width=int(scale * 5))

    # Center culinary herb leaf (fresh ingredient symbol)
    leaf_cx = cx
    leaf_cy = int(h * 0.24)
    leaf_w = int(w * 0.09)
    leaf_h = int(h * 0.14)
    
    # Draw leaf shape
    leaf_pts = [
        (leaf_cx, leaf_cy - leaf_h // 2),
        (leaf_cx + leaf_w // 2, leaf_cy),
        (leaf_cx, leaf_cy + leaf_h // 2),
        (leaf_cx - leaf_w // 2, leaf_cy),
    ]
    draw.polygon(leaf_pts, fill=(245, 235, 220, 240))
    # Leaf center vein
    draw.line([(leaf_cx, leaf_cy - leaf_h // 2), (leaf_cx, leaf_cy + leaf_h // 2)], fill=TERRACOTTA, width=int(scale * 2.5))

    # Right steam curl
    draw.arc([cx + int(w * 0.02), steam_y - int(h * 0.08), cx + int(w * 0.22), steam_y + int(h * 0.12)],
             start=180, end=340, fill=(255, 255, 255, 200), width=int(scale * 5))

    # 3. Pot Lid / Cloche
    lid_w = int(w * 0.52)
    lid_h = int(h * 0.15)
    lid_y = cy - int(h * 0.16)

    # Lid handle (golden knob)
    knob_r = int(w * 0.045)
    knob_cx = cx
    knob_cy = lid_y - int(h * 0.015)
    draw.ellipse([knob_cx - knob_r, knob_cy - knob_r, knob_cx + knob_r, knob_cy + knob_r], fill=WARM_GOLD)

    # Lid dome
    draw.chord([cx - lid_w // 2, lid_y - lid_h // 2, cx + lid_w // 2, lid_y + lid_h // 2 + int(scale * 6)],
               start=180, end=360, fill=WHITE)
    draw.rectangle([cx - lid_w // 2, lid_y + int(scale * 2), cx + lid_w // 2, lid_y + int(scale * 8)], fill=WHITE)

    # 4. Pot Body (Casserole / Dutch Oven)
    pot_w = int(w * 0.48)
    pot_h = int(h * 0.26)
    pot_top = cy - int(h * 0.12)
    pot_box = [cx - pot_w // 2, pot_top, cx + pot_w // 2, pot_top + pot_h]

    # Draw casserole body
    pot_radius = int(w * 0.06)
    draw.rounded_rectangle(pot_box, radius=pot_radius, fill=WHITE)

    # Pot rim accent line
    draw.line([cx - pot_w // 2, pot_top + int(scale * 6), cx + pot_w // 2, pot_top + int(scale * 6)], fill=(230, 225, 220), width=int(scale * 2))

    # Golden side handles
    handle_w = int(w * 0.06)
    handle_h = int(h * 0.08)
    handle_y = pot_top + int(h * 0.03)

    # Left handle
    draw.arc([cx - pot_w // 2 - handle_w, handle_y, cx - pot_w // 2 + handle_w // 3, handle_y + handle_h],
             start=90, end=270, fill=WARM_GOLD, width=int(scale * 4.5))
    # Right handle
    draw.arc([cx + pot_w // 2 - handle_w // 3, handle_y, cx + pot_w // 2 + handle_w, handle_y + handle_h],
             start=270, end=90, fill=WARM_GOLD, width=int(scale * 4.5))

    # 5. Chef Heart / Utensil Accent on pot body
    heart_y = pot_top + int(pot_h * 0.48)
    heart_r = int(w * 0.035)
    # Warm heart or star icon on pot
    draw.ellipse([cx - heart_r - int(scale * 5), heart_y - heart_r, cx - int(scale * 5) + heart_r, heart_y + heart_r], fill=DARK_TERRACOTTA)
    draw.ellipse([cx + int(scale * 5) - heart_r, heart_y - heart_r, cx + int(scale * 5) + heart_r, heart_y + heart_r], fill=DARK_TERRACOTTA)
    tri_pts = [
        (cx - heart_r * 2 + int(scale * 2), heart_y),
        (cx + heart_r * 2 - int(scale * 2), heart_y),
        (cx, heart_y + int(heart_r * 1.8)),
    ]
    draw.polygon(tri_pts, fill=DARK_TERRACOTTA)

    # Supersampling downscale with Lanczos for anti-aliased edges
    final = icon_bg.resize((size, size), Image.Resampling.LANCZOS)
    return final


def create_open_graph_image(w: int = 1200, h: int = 630) -> Image.Image:
    """Create a 1200x630 Open Graph preview card for WhatsApp and social links."""
    img = Image.new("RGB", (w, h), CREAM)
    draw = ImageDraw.Draw(img)

    # Warm subtle backdrop elements
    # Diagonal decorative accent band
    for i in range(h):
        factor = i / h
        r = int(CREAM[0] * (1 - factor * 0.05))
        g = int(CREAM[1] * (1 - factor * 0.05))
        b = int(CREAM[2] * (1 - factor * 0.05))
        draw.line([(0, i), (w, i)], fill=(r, g, b))

    # Top border brand strip
    draw.rectangle([0, 0, w, 10], fill=TERRACOTTA)

    # Left: App Icon (380x380) with soft drop shadow
    icon_size = 380
    icon = create_app_icon(icon_size)

    icon_x = 100
    icon_y = (h - icon_size) // 2

    # Draw soft drop shadow
    shadow = Image.new("RGBA", (icon_size + 40, icon_size + 40), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle([15, 20, icon_size + 25, icon_size + 30], radius=int(icon_size * 0.22), fill=(0, 0, 0, 35))
    img.paste(shadow, (icon_x - 10, icon_y - 5), shadow)
    img.paste(icon, (icon_x, icon_y), icon)

    # Right: Text Content
    text_x = icon_x + icon_size + 80

    # Fonts: try default or scalable truetype
    try:
        title_font = ImageFont.truetype("arialbd.ttf", 64)
        subtitle_font = ImageFont.truetype("arial.ttf", 30)
        pill_font = ImageFont.truetype("arialbd.ttf", 22)
        badge_font = ImageFont.truetype("arialbd.ttf", 20)
    except Exception:
        title_font = subtitle_font = pill_font = badge_font = ImageFont.load_default()

    # Brand Title
    draw.text((text_x, icon_y + 30), "Recipe Manager", fill=DARK_TERRACOTTA, font=title_font)

    # Subtitle
    draw.text((text_x, icon_y + 115), "Your bilingual kitchen library", fill=DARK_SLATE, font=subtitle_font)
    draw.text((text_x, icon_y + 165), fix_hebrew("ספר המתכונים הדו-לשוני שלך"), fill=MUTED_SLATE, font=subtitle_font)

    # Feature Pills
    features = [
        "Reel & Video Extractor",
        "OneNote & WhatsApp Batch",
        "Cook Mode",
        "Shopping List",
        fix_hebrew("English & עברית"),
    ]

    pill_y = icon_y + 230
    curr_x = text_x
    for feat in features:
        # Measure text width using font bounding box
        try:
            bbox = pill_font.getbbox(feat)
            text_w = bbox[2] - bbox[0]
            pill_w = text_w + 28
        except Exception:
            pill_w = len(feat) * 12 + 28

        if curr_x + pill_w > w - 40:
            curr_x = text_x
            pill_y += 48
        draw.rounded_rectangle([curr_x, pill_y, curr_x + pill_w, pill_y + 36], radius=18, fill=WHITE, outline=TERRACOTTA, width=1)
        draw.text((curr_x + 14, pill_y + 7), feat, fill=DARK_TERRACOTTA, font=pill_font)
        curr_x += pill_w + 14

    # Bottom domain watermark
    draw.text((text_x, h - 85), "noamsee.github.io/recipe-manager", fill=MUTED_SLATE, font=badge_font)

    return img


def create_svg_icon() -> str:
    """Create a modern vector SVG icon for browsers that support SVG favicons."""
    return """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs>
    <linearGradient id="terracotta-grad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#D94826"/>
      <stop offset="100%" stop-color="#A8381C"/>
    </linearGradient>
    <linearGradient id="gold-grad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#FCD34D"/>
      <stop offset="100%" stop-color="#D97706"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="120%">
      <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#000" flood-opacity="0.18"/>
    </filter>
  </defs>

  <!-- Rounded Squircle Background -->
  <rect x="24" y="24" width="464" height="464" rx="104" fill="url(#terracotta-grad)"/>
  <rect x="24" y="24" width="464" height="464" rx="104" fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="4"/>

  <!-- Steam & Aromatic Leaf -->
  <g fill="none" stroke="rgba(255,255,255,0.85)" stroke-width="14" stroke-linecap="round">
    <path d="M 210 170 C 190 140, 200 110, 220 90"/>
    <path d="M 302 170 C 322 140, 312 110, 292 90"/>
  </g>
  <!-- Fresh Herb Leaf (Center Steam) -->
  <path d="M 256 70 Q 280 105 256 140 Q 232 105 256 70 Z" fill="#FFF8F0"/>
  <line x1="256" y1="80" x2="256" y2="130" stroke="#C44B2B" stroke-width="4" stroke-linecap="round"/>

  <!-- Dutch Oven / Casserole Body -->
  <g filter="url(#shadow)">
    <!-- Golden Side Handles -->
    <path d="M 100 280 C 85 280, 85 320, 100 320" fill="none" stroke="url(#gold-grad)" stroke-width="16" stroke-linecap="round"/>
    <path d="M 412 280 C 427 280, 427 320, 412 320" fill="none" stroke="url(#gold-grad)" stroke-width="16" stroke-linecap="round"/>

    <!-- Pot Body -->
    <rect x="116" y="260" width="280" height="135" rx="36" fill="#FFFFFF"/>
    <!-- Pot Rim -->
    <line x1="126" y1="272" x2="386" y2="272" stroke="#E5E0DB" stroke-width="4"/>

    <!-- Pot Lid -->
    <path d="M 120 250 Q 256 185 392 250 Z" fill="#FFFFFF"/>
    <rect x="114" y="246" width="284" height="14" rx="7" fill="#FFFFFF"/>
    <!-- Lid Knob -->
    <circle cx="256" cy="195" r="20" fill="url(#gold-grad)"/>

    <!-- Heart / Culinary Love Accent -->
    <path d="M 256 312 C 256 302, 240 292, 230 302 C 220 312, 230 324, 256 342 C 282 324, 292 312, 282 302 C 272 292, 256 302, 256 312 Z" fill="#C44B2B"/>
  </g>
</svg>
"""


def main():
    print("Generating Recipe Manager icon assets...")

    # 1. High-resolution master icon (512x512)
    icon_512 = create_app_icon(512)
    icon_512.save(ASSETS_DIR / "icon-512.png", "PNG")
    print("Saved assets/icon-512.png")

    # 2. PWA & mobile icon (192x192)
    icon_192 = icon_512.resize((192, 192), Image.Resampling.LANCZOS)
    icon_192.save(ASSETS_DIR / "icon-192.png", "PNG")
    print("Saved assets/icon-192.png")

    # 3. Apple Touch Icon (180x180)
    icon_180 = icon_512.resize((180, 180), Image.Resampling.LANCZOS)
    icon_180.save(ASSETS_DIR / "apple-touch-icon.png", "PNG")
    print("Saved assets/apple-touch-icon.png")

    # 4. Favicon 32x32 & 16x16
    icon_32 = icon_512.resize((32, 32), Image.Resampling.LANCZOS)
    icon_32.save(ASSETS_DIR / "favicon-32x32.png", "PNG")
    print("Saved assets/favicon-32x32.png")

    icon_16 = icon_512.resize((16, 16), Image.Resampling.LANCZOS)
    icon_16.save(ASSETS_DIR / "favicon-16x16.png", "PNG")
    print("Saved assets/favicon-16x16.png")

    # 5. Multi-size favicon.ico
    icon_512.save(
        "favicon.ico",
        format="ICO",
        sizes=[(16, 16), (32, 32), (48, 48), (64, 64)],
    )
    print("Saved root favicon.ico")

    # 6. Scalable SVG icon
    svg_content = create_svg_icon()
    with open(ASSETS_DIR / "icon.svg", "w", encoding="utf-8") as f:
        f.write(svg_content)
    print("Saved assets/icon.svg")

    # 7. Open Graph WhatsApp & Social Preview Image (1200x630)
    og_image = create_open_graph_image(1200, 630)
    og_image.save(ASSETS_DIR / "og-preview.png", "PNG", optimize=True)
    print("Saved assets/og-preview.png (Open Graph / WhatsApp preview)")


if __name__ == "__main__":
    main()
