from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parent
FONT_ZH = Path(r"C:\Windows\Fonts\msyhbd.ttc")
FONT_EN = Path(r"C:\Windows\Fonts\bahnschrift.ttf")
IVORY = "#f2eadb"
INK = "#17211b"
ORANGE = "#e25832"
MOSS = "#2d7653"


def font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(path), size=size)


def draw_tracking(draw: ImageDraw.ImageDraw, xy: tuple[int, int], text: str, face: ImageFont.FreeTypeFont, fill: str, spacing: int) -> None:
    x, y = xy
    for character in text:
        draw.text((x, y), character, font=face, fill=fill)
        x += int(draw.textlength(character, font=face)) + spacing


def add_landscape_overlay(image: Image.Image) -> Image.Image:
    image = image.resize((1920, 1080), Image.Resampling.LANCZOS).convert("RGBA")
    shade = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shade_draw = ImageDraw.Draw(shade)
    for x in range(1120):
        progress = x / 1120
        alpha = int(142 * (1 - progress) ** 1.8)
        shade_draw.line((x, 0, x, 1080), fill=(6, 17, 12, alpha))
    image = Image.alpha_composite(image, shade)
    draw = ImageDraw.Draw(image)

    logo = Image.open(ROOT / "logo.png").convert("RGBA").resize((78, 78), Image.Resampling.LANCZOS)
    image.alpha_composite(logo, (112, 92))
    draw.text((210, 102), "随码", font=font(FONT_ZH, 31), fill=IVORY)
    draw.text((210, 143), "ANYTIMEVIBE", font=font(FONT_EN, 18), fill="#aeb9b0")

    draw_tracking(draw, (110, 260), "随时随地", font(FONT_ZH, 110), IVORY, 8)
    draw.text((110, 400), "VIBE CODING", font=font(FONT_EN, 99), fill=IVORY)
    draw.rounded_rectangle((110, 528, 340, 538), radius=5, fill=ORANGE)

    draw.text((110, 568), "手机下发任务  ·  电脑本机执行", font=font(FONT_ZH, 32), fill="#d7dfd8")
    draw.rounded_rectangle((110, 646, 394, 708), radius=16, fill=ORANGE)
    draw.text((140, 659), "任务一键接力", font=font(FONT_ZH, 27), fill="#ffffff")

    draw.text((110, 768), "CODEX  ·  CLAUDE CODE  ·  GROK  ·  CURSOR", font=font(FONT_EN, 19), fill="#91a097")
    draw.text((110, 817), "源码与凭据留在本机", font=font(FONT_ZH, 22), fill="#91a097")
    return image.convert("RGB")


def add_portrait_overlay(image: Image.Image) -> Image.Image:
    image = image.resize((1080, 1920), Image.Resampling.LANCZOS).convert("RGBA")
    shade = Image.new("RGBA", image.size, (0, 0, 0, 0))
    shade_draw = ImageDraw.Draw(shade)
    for y in range(820):
        progress = y / 820
        alpha = int(82 * (1 - progress) ** 1.6)
        shade_draw.line((0, y, 1080, y), fill=(6, 17, 12, alpha))
    image = Image.alpha_composite(image, shade)
    draw = ImageDraw.Draw(image)

    logo = Image.open(ROOT / "logo.png").convert("RGBA").resize((70, 70), Image.Resampling.LANCZOS)
    image.alpha_composite(logo, (74, 76))
    draw.text((166, 82), "随码", font=font(FONT_ZH, 30), fill=IVORY)
    draw.text((166, 121), "ANYTIMEVIBE", font=font(FONT_EN, 18), fill="#aeb9b0")

    draw_tracking(draw, (70, 222), "随时随地", font(FONT_ZH, 91), IVORY, 8)
    draw.text((70, 340), "VIBE CODING", font=font(FONT_EN, 82), fill=IVORY)
    draw.rounded_rectangle((72, 452, 272, 462), radius=5, fill=ORANGE)
    draw.text((72, 490), "灵感不断，任务不停", font=font(FONT_ZH, 34), fill="#d7dfd8")

    draw.rounded_rectangle((72, 572, 534, 638), radius=17, fill=IVORY)
    draw.text((100, 587), "手机下发 · 电脑执行", font=font(FONT_ZH, 27), fill=INK)
    draw.rounded_rectangle((552, 572, 940, 638), radius=17, fill=ORANGE)
    draw.text((586, 587), "任务一键接力", font=font(FONT_ZH, 27), fill="#ffffff")

    draw.text((74, 684), "CODEX  ·  CLAUDE  ·  GROK  ·  CURSOR", font=font(FONT_EN, 18), fill="#91a097")
    return image.convert("RGB")


def main() -> None:
    landscape = Image.open(ROOT / "landscape-background-image2.png")
    portrait = Image.open(ROOT / "portrait-background-image2.png")
    add_landscape_overlay(landscape).save(ROOT / "anytimevibe-cover-landscape-1920x1080.jpg", quality=94, subsampling=0)
    add_portrait_overlay(portrait).save(ROOT / "anytimevibe-cover-portrait-1080x1920.jpg", quality=94, subsampling=0)


if __name__ == "__main__":
    main()
