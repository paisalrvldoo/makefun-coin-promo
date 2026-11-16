#!/usr/bin/env python3
"""Draw the WILLCODE logo and its previews with Pillow and numpy."""

from pathlib import Path
import math

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont


SIZE = 1024
SCALE = 2
WORK_SIZE = SIZE * SCALE
ROOT = Path(__file__).resolve().parent
MARKER_FONT = Path(
    "/usr/share/fonts/truetype/sand-box/google/Permanent Marker/"
    "PermanentMarker-Regular.ttf"
)
TAG_FONT = Path("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf")
INK = (21, 18, 14, 255)
METAL_OUTLINE = (34, 43, 54, 255)
RNG_SEED = 42017
SIGN_TILT = -3.0
TAG_SCALE = 1.30
SIGN_HOLE = (887, 779)


def point(x, y):
    return round(x * SCALE), round(y * SCALE)


def box(coords):
    return tuple(round(v * SCALE) for v in coords)


def blank():
    return Image.new("RGBA", (WORK_SIZE, WORK_SIZE), (0, 0, 0, 0))


def background():
    yy, xx = np.mgrid[:WORK_SIZE, :WORK_SIZE].astype(np.float32)
    distance = np.hypot(xx / SCALE - 512, yy / SCALE - 470)
    # A smooth, finite glow leaves the outer background exactly USDC blue.
    fade = np.clip((610 - distance) / 160, 0, 1)
    fade = fade * fade * (3 - 2 * fade)
    glow = 0.52 * np.exp(-np.square(distance / 355)) * fade
    base = np.array([0x27, 0x75, 0xCA], dtype=np.float32)
    light = np.array([133, 199, 249], dtype=np.float32)
    rgb = base + glow[:, :, None] * (light - base)
    return Image.fromarray(np.rint(rgb).astype(np.uint8)).convert("RGBA")


def shadow(canvas, mask, offset=(8, 14), blur=12, opacity=80):
    alpha = mask.filter(ImageFilter.GaussianBlur(blur * SCALE))
    alpha = alpha.point(lambda value: round(value * opacity / 255))
    shade = Image.new("RGBA", canvas.size, (10, 25, 42, 0))
    shade.putalpha(alpha)
    translated = blank()
    translated.alpha_composite(shade, dest=point(*offset))
    canvas.alpha_composite(translated)


def rivet(draw, x, y, radius=4):
    draw.ellipse(box((x - radius, y - radius, x + radius, y + radius)),
                 fill=(82, 94, 106, 255))
    draw.ellipse(box((x - radius + 1, y - radius + 1, x + radius - 1, y + radius - 1)),
                 outline=(222, 230, 236, 255), width=SCALE)
    draw.ellipse(box((x - 1.5, y - 2, x + 0.5, y)), fill=(246, 248, 250, 255))


def metal_panel(canvas, bounds, radius=14, angle=0, outline_width=6):
    x0, y0, x1, y1 = bounds
    width, height = x1 - x0, y1 - y0
    pad = 9
    tile_size = point(width + 2 * pad, height + 2 * pad)
    yy, xx = np.mgrid[:tile_size[1], :tile_size[0]].astype(np.float32)
    u = (xx / SCALE - pad) / width
    v = (yy / SCALE - pad) / height
    sheen = 31 * np.exp(-np.square((u - 0.30) / 0.30))
    shade = 22 * np.clip(u, 0, 1) + 17 * np.clip(v, 0, 1)
    colors = np.array([183, 193, 204], dtype=np.float32)
    rgb = np.clip(colors + (sheen - shade)[:, :, None], 0, 255).astype(np.uint8)
    tile = Image.fromarray(rgb).convert("RGBA")
    mask = Image.new("L", tile.size, 0)
    panel_box = box((pad, pad, pad + width, pad + height))
    ImageDraw.Draw(mask).rounded_rectangle(panel_box, radius=round(radius * SCALE), fill=255)
    tile.putalpha(mask)
    draw = ImageDraw.Draw(tile)
    draw.rounded_rectangle(panel_box, radius=round(radius * SCALE),
                           outline=METAL_OUTLINE, width=round(outline_width * SCALE))
    draw.line([point(pad + 12, pad + 8), point(pad + width - 13, pad + 8)],
              fill=(241, 246, 250, 255), width=2 * SCALE)
    tile.putalpha(mask)
    if angle:
        tile = tile.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    dest = (round((x0 + width / 2) * SCALE - tile.width / 2),
            round((y0 + height / 2) * SCALE - tile.height / 2))
    canvas.alpha_composite(tile, dest=dest)


def metal_curve(canvas, controls, width):
    """A rounded, shaded curved digit, rather than a rectangular knuckle plate."""
    t = np.linspace(0, 1, 80)[:, None]
    a, b, c, d = (np.array(p, dtype=np.float32) for p in controls)
    curve = (1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d
    padding = width / 2 + 5
    origin = np.floor(curve.min(axis=0) - padding)
    extent = np.ceil(curve.max(axis=0) + padding - origin)
    mask = Image.new("L", point(*extent), 0)
    draw = ImageDraw.Draw(mask)
    local = curve - origin
    draw.line([point(*p) for p in local], fill=255, width=round(width * SCALE), joint="curve")
    for x, y in (local[0], local[-1]):
        draw.ellipse(box((x - width / 2, y - width / 2, x + width / 2, y + width / 2)), fill=255)
    yy, xx = np.mgrid[:mask.height, :mask.width].astype(np.float32)
    v = yy / max(mask.height - 1, 1)
    sheen = 27 * np.exp(-np.square((v - 0.29) / 0.24)) - 22 * v
    rgb = np.clip(np.array([187, 199, 209], dtype=np.float32) + sheen[:, :, None], 0, 255)
    edge = (np.asarray(mask, dtype=np.float32) - np.asarray(
        mask.filter(ImageFilter.MinFilter(17)), dtype=np.float32)) / 255
    rgb = rgb * (1 - edge[:, :, None]) + np.array(METAL_OUTLINE[:3]) * edge[:, :, None]
    tile = Image.fromarray(rgb.astype(np.uint8)).convert("RGBA")
    tile.putalpha(mask)
    canvas.alpha_composite(tile, dest=point(*origin))


def robot_head():
    layer = blank()
    draw = ImageDraw.Draw(layer)
    draw.line([point(512, 69), point(512, 110)], fill=METAL_OUTLINE, width=14 * SCALE)
    draw.line([point(510, 71), point(510, 107)], fill=(207, 224, 235, 255), width=5 * SCALE)
    for bounds in ((316, 163, 348, 225), (676, 163, 708, 225)):
        metal_panel(layer, bounds, radius=14, outline_width=7)
    metal_panel(layer, (330, 103, 694, 319), radius=68, outline_width=9)
    draw = ImageDraw.Draw(layer)
    draw.rounded_rectangle(box((357, 133, 667, 278)), radius=43 * SCALE,
                           fill=(15, 36, 48, 255), outline=(82, 107, 124, 255), width=5 * SCALE)

    lights = blank()
    light_draw = ImageDraw.Draw(lights)
    for bounds in ((386, 176, 475, 241), (549, 176, 638, 241)):
        light_draw.rounded_rectangle(box(bounds), radius=25 * SCALE, fill=(44, 221, 255, 255))
    # Raised inner brows give the hopeful, asking-for-work expression.
    for start, end in (((391, 162), (461, 149)), ((563, 149), (633, 162))):
        light_draw.line([point(*start), point(*end)], fill=(75, 229, 255, 255), width=8 * SCALE)
    halo = lights.filter(ImageFilter.GaussianBlur(8 * SCALE))
    layer.alpha_composite(halo)
    layer.alpha_composite(lights)
    draw = ImageDraw.Draw(layer)
    for x in (397, 560):
        draw.rounded_rectangle(box((x, 183, x + 11, 219)), radius=5 * SCALE,
                               fill=(186, 249, 255, 255))
    draw.arc(box((487, 239, 537, 267)), start=15, end=165,
             fill=(58, 188, 218, 255), width=3 * SCALE)

    beacon = blank()
    ImageDraw.Draw(beacon).ellipse(box((498, 44, 526, 72)), fill=(36, 170, 255, 255))
    layer.alpha_composite(beacon.filter(ImageFilter.GaussianBlur(7 * SCALE)))
    draw = ImageDraw.Draw(layer)
    draw.ellipse(box((497, 43, 527, 73)), fill=(51, 182, 255, 255),
                 outline=METAL_OUTLINE, width=4 * SCALE)
    draw.ellipse(box((503, 48, 513, 57)), fill=(192, 239, 255, 255))
    return layer


def rear_hands():
    layer = blank()
    for right in (False, True):
        def mirrored_points(controls):
            return [(SIZE - x if right else x, y) for x, y in controls]

        # Continuous forearm from the lower body area up to the side of the sign.
        metal_curve(layer, mirrored_points(((213, 824), (136, 826), (96, 751), (112, 682))), width=58)
        metal_curve(layer, mirrored_points(((113, 704), (92, 684), (92, 663), (107, 648))), width=76)
        # The thumb stays behind the board; only curled fingers go on the front.
        metal_curve(layer, mirrored_points(((127, 704), (153, 707), (178, 727), (165, 748))), width=31)
        draw = ImageDraw.Draw(layer)
        draw.line([point(*p) for p in mirrored_points(((91, 701), (121, 717)))],
                  fill=(75, 90, 106, 255), width=4 * SCALE)
        draw.line([point(*p) for p in mirrored_points(((160, 803), (177, 779)))],
                  fill=(75, 90, 106, 255), width=4 * SCALE)
        rivet(draw, SIZE - 187 if right else 187, 816, radius=4.5)
    return layer


def cardboard():
    outline = [
        (142, 218), (178, 213), (217, 218), (249, 213), (306, 216),
        (348, 211), (394, 216), (443, 214), (494, 220), (538, 217),
        (585, 222), (634, 219), (681, 224), (728, 221), (768, 226),
        (812, 221), (851, 226), (886, 223), (882, 257), (886, 281),
        (879, 310), (887, 345), (882, 379), (887, 416), (882, 445),
        (888, 482), (883, 518), (887, 551), (882, 585), (885, 618),
        (879, 646), (884, 678), (878, 707), (877, 735), (836, 732),
        (803, 738), (765, 731), (726, 737), (688, 729), (651, 734),
        (614, 727), (575, 733), (536, 724), (497, 730), (455, 723),
        (415, 729), (377, 722), (338, 727), (299, 719), (258, 725),
        (218, 717), (177, 722), (135, 715), (141, 677), (135, 641),
        (143, 602), (137, 568), (144, 530), (137, 490), (143, 452),
        (136, 415), (143, 374), (139, 336), (145, 298), (140, 262),
    ]
    # Reuse the original torn contour, widening and lowering it for the head.
    outline = [(512 + (x - 512) * 1.055, y + 61) for x, y in outline]
    mask = Image.new("L", (WORK_SIZE, WORK_SIZE), 0)
    ImageDraw.Draw(mask).polygon([point(*p) for p in outline], fill=255)
    yy, xx = np.mgrid[:WORK_SIZE, :WORK_SIZE].astype(np.float32)
    x, y = xx / SCALE, yy / SCALE
    rng = np.random.default_rng(RNG_SEED)
    grain = rng.normal(0, 2.4, (WORK_SIZE, WORK_SIZE)).astype(np.float32)
    corrugation = 1.25 * np.cos(x * 2 * math.pi / 21)
    broad_variation = 1.7 * np.sin(x / 210 + y / 390) - (y - 400) / 175
    texture = grain + corrugation + broad_variation
    edge = np.asarray(mask, dtype=np.float32) - np.asarray(
        mask.filter(ImageFilter.MinFilter(17)), dtype=np.float32)
    base = np.array([201, 155, 99], dtype=np.float32)
    rgb = base + texture[:, :, None] * np.array([1, 0.86, 0.68], dtype=np.float32)
    rgb -= (edge / 255)[:, :, None] * np.array([32, 29, 22], dtype=np.float32)
    layer = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).convert("RGBA")
    layer.putalpha(mask)
    draw = ImageDraw.Draw(layer)
    draw.line([point(*p) for p in outline + [outline[0]]],
              fill=(119, 86, 48, 255), width=3 * SCALE, joint="curve")
    # Sparse exposed paper fibers along a few tears, not a heavy black frame.
    for start, end in (((236, 277), (292, 280)), ((389, 280), (436, 278)),
                       ((782, 290), (824, 285)), ((332, 785), (366, 780)),
                       ((621, 789), (655, 793))):
        draw.line([point(*start), point(*end)], fill=(220, 177, 119, 255), width=SCALE)
    hx, hy = SIGN_HOLE
    draw.ellipse(box((hx - 11, hy - 11, hx + 11, hy + 11)),
                 outline=(115, 82, 43, 255), width=3 * SCALE)
    draw.ellipse(box((hx - 8, hy - 8, hx + 8, hy + 8)), fill=(0, 0, 0, 0))
    return layer


def marker_line(canvas, text, center, width, angle, stroke_px=3.5, stretch_y=1.0):
    reference = ImageFont.truetype(str(MARKER_FONT), 100)
    bounds = reference.getbbox(text)
    font_size = round(width * 100 / (bounds[2] - bounds[0]))
    font = ImageFont.truetype(str(MARKER_FONT), font_size * SCALE)
    stroke = round(stroke_px * SCALE)
    bounds = font.getbbox(text, stroke_width=stroke)
    pad = 12 * SCALE
    tile = Image.new("RGBA", (bounds[2] - bounds[0] + 2 * pad,
                               bounds[3] - bounds[1] + 2 * pad), (0, 0, 0, 0))
    ImageDraw.Draw(tile).text((pad - bounds[0], pad - bounds[1]), text,
                             font=font, fill=INK, stroke_width=stroke, stroke_fill=INK)
    if stretch_y != 1:
        tile = tile.resize((tile.width, round(tile.height * stretch_y)), Image.Resampling.LANCZOS)
    tile = tile.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    dest = (round(center[0] * SCALE - tile.width / 2),
            round(center[1] * SCALE - tile.height / 2))
    canvas.alpha_composite(tile, dest=dest)


def marker_underline(canvas):
    # A single uneven marker stroke, with rough ends and varying pressure.
    vertices = [(224, 774), (269, 771), (387, 774), (484, 770), (593, 774),
                (723, 771), (800, 775), (807, 781), (749, 784), (621, 781),
                (474, 786), (363, 781), (272, 784), (218, 780)]
    ImageDraw.Draw(canvas).polygon([point(x, y - 10) for x, y in vertices], fill=INK)


def front_fingers():
    layer = blank()
    # Unequal curved digits grow from one palm and wrap across the cardboard edge.
    fingers = (
        (((103, 640), (128, 627), (162, 628), (181, 642)), 35,
         ((132, 631, 128, 651), (160, 633, 153, 656))),
        (((100, 674), (129, 662), (167, 669), (185, 684)), 36,
         ((130, 666, 127, 690), (162, 672, 153, 696))),
        (((107, 708), (133, 702), (161, 714), (177, 722)), 33,
         ((132, 703, 126, 726), (160, 714, 150, 735))),
        (((116, 738), (136, 737), (155, 748), (164, 758)), 29,
         ((137, 740, 131, 759),)),
    )
    for right in (False, True):
        for controls, width, joints in fingers:
            controls = [(SIZE - x if right else x, y) for x, y in controls]
            metal_curve(layer, controls, width)
            draw = ImageDraw.Draw(layer)
            for x0, y0, x1, y1 in joints:
                if right:
                    x0, x1 = SIZE - x0, SIZE - x1
                draw.line([point(x0, y0), point(x1, y1)],
                          fill=(85, 103, 119, 255), width=3 * SCALE)
    return layer


def paper_tag():
    width, height = 210, 110
    tile = Image.new("RGBA", point(width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(tile)
    vertices = [(10, 22), (155, 22), (184, 43), (184, 67), (155, 88), (10, 88)]
    draw.polygon([point(*p) for p in vertices], fill=(255, 242, 213, 255))
    draw.line([point(*p) for p in vertices + [vertices[0]]],
              fill=(99, 79, 50, 255), width=3 * SCALE, joint="curve")
    draw.line([point(17, 26), point(151, 26)], fill=(255, 252, 235, 255), width=2 * SCALE)
    font = ImageFont.truetype(str(TAG_FONT), 25 * SCALE)
    bounds = draw.textbbox((0, 0), "make.fun", font=font)
    draw.text((round(81 * SCALE - (bounds[2] - bounds[0]) / 2) - bounds[0],
               round(55 * SCALE - (bounds[3] - bounds[1]) / 2) - bounds[1]),
              "make.fun", font=font, fill=(44, 37, 27, 255))
    hole = (167, 55)
    draw.ellipse(box((hole[0] - 6, hole[1] - 6, hole[0] + 6, hole[1] + 6)),
                 fill=(105, 79, 45, 255), outline=(215, 193, 152, 255), width=2 * SCALE)
    angle = -11
    center = (727, 846)
    radians = math.radians(angle)
    dx, dy = (hole[0] - width / 2) * TAG_SCALE, (hole[1] - height / 2) * TAG_SCALE
    attachment = (center[0] + math.cos(radians) * dx + math.sin(radians) * dy,
                  center[1] - math.sin(radians) * dx + math.cos(radians) * dy)
    tile = tile.resize((round(tile.width * TAG_SCALE), round(tile.height * TAG_SCALE)),
                       Image.Resampling.LANCZOS)
    tile = tile.rotate(angle, resample=Image.Resampling.BICUBIC, expand=True)
    layer = blank()
    layer.alpha_composite(tile, dest=(round(center[0] * SCALE - tile.width / 2),
                                      round(center[1] * SCALE - tile.height / 2)))
    return layer, attachment


def tag_string(attachment):
    layer = blank()
    draw = ImageDraw.Draw(layer)
    anchor = SIGN_HOLE
    t = np.linspace(0, 1, 100)
    a, b, c, d = (np.array(p, dtype=np.float64) for p in
                  (anchor, (908, 815), (835, 837), attachment))
    curve = ((1 - t)[:, None] ** 3 * a +
             3 * ((1 - t) ** 2 * t)[:, None] * b +
             3 * ((1 - t) * t ** 2)[:, None] * c + t[:, None] ** 3 * d)
    draw.line([point(x + 1, y + 1) for x, y in curve],
              fill=(67, 57, 41, 230), width=4 * SCALE, joint="curve")
    draw.line([point(x, y) for x, y in curve],
              fill=(232, 212, 174, 255), width=2 * SCALE, joint="curve")
    return layer


def main():
    for font_path in (MARKER_FONT, TAG_FONT):
        if not font_path.is_file():
            raise FileNotFoundError(f"Required font is missing: {font_path}")
    canvas = background()
    subjects = blank()

    head = robot_head()
    shadow(canvas, head.getchannel("A"), offset=(5, 8), blur=10, opacity=70)
    canvas.alpha_composite(head)
    subjects.alpha_composite(head)

    # Build one held object so cardboard, grip, underline and tag tilt together.
    held = blank()
    held_subjects = blank()

    hands = rear_hands()
    shadow(held, hands.getchannel("A"), offset=(5, 9), blur=8, opacity=65)
    held.alpha_composite(hands)
    held_subjects.alpha_composite(hands)

    sign = cardboard()
    shadow(held, sign.getchannel("A"), offset=(10, 17), blur=15, opacity=100)
    marker_line(sign, "WILL CODE", center=(512, 360), width=738, angle=0.8, stretch_y=1.20)
    marker_line(sign, "FOR", center=(510, 491), width=300, angle=-0.6)
    marker_line(sign, "USDC", center=(514, 659), width=600, angle=0.7, stroke_px=4)
    marker_underline(sign)
    held.alpha_composite(sign)
    held_subjects.alpha_composite(sign)

    fingers = front_fingers()
    shadow(held, fingers.getchannel("A"), offset=(1, 3), blur=3, opacity=65)
    held.alpha_composite(fingers)
    held_subjects.alpha_composite(fingers)

    tag, attachment = paper_tag()
    string = tag_string(attachment)
    held.alpha_composite(string)
    held_subjects.alpha_composite(string)
    shadow(held, tag.getchannel("A"), offset=(2, 4), blur=4, opacity=70)
    held.alpha_composite(tag)
    held_subjects.alpha_composite(tag)

    held = held.rotate(SIGN_TILT, resample=Image.Resampling.BICUBIC)
    held_subjects = held_subjects.rotate(SIGN_TILT, resample=Image.Resampling.BICUBIC)
    canvas.alpha_composite(held)
    subjects.alpha_composite(held_subjects)

    # Protect actual foreground details from pump.fun's centered circular crop.
    ys, xs = np.nonzero(np.asarray(subjects.getchannel("A")) > 32)
    max_radius = np.hypot(xs / SCALE - 512, ys / SCALE - 512).max()
    if max_radius > 500:
        raise ValueError(f"Foreground exceeds circular safe area: {max_radius:.1f}px")

    assets = ROOT / "assets"
    assets.mkdir(exist_ok=True)
    logo = canvas.convert("RGB").resize((SIZE, SIZE), Image.Resampling.LANCZOS)
    logo_path = assets / "logo.png"
    logo.save(logo_path, optimize=True)
    if logo_path.stat().st_size > 5 * 1024 * 1024:
        raise ValueError("Logo exceeds pump.fun's 5 MiB image limit")
    print(f"assets/logo.png: {SIZE}x{SIZE}, {logo_path.stat().st_size:,} bytes")
    for size in (64, 512):
        path = assets / f"preview_{size}.png"
        logo.resize((size, size), Image.Resampling.LANCZOS).save(path, optimize=True)
        print(f"assets/{path.name}: {size}x{size}")
    print(f"Foreground fits a {max_radius:.1f}px radius (circle radius: 512px).")


if __name__ == "__main__":
    main()
