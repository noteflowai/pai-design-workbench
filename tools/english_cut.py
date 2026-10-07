"""Cut an English-captioned version of a published demo video for talks.

Usage: python3 tools/english_cut.py <spec.json> <output.mp4>
       python3 tools/english_cut.py <spec.json> --check      # resolve every caption, render nothing

The spec names the source video, its receipt and a list of segments. Segments keep their recorded order and are only
trimmed and sped up; each segment shows its speed. The UI (Chinese) is cropped above its own caption bubble; an
English caption band and an evidence column are drawn over it. Caption numbers are templates resolved from the
receipt's `facts`, so a number cannot be retyped:

  {facts.ai.mass}                     the value as recorded
  {um:facts.formal.bore}              millimetres shown as micrometres, 2 decimals
  {pct1:facts.formal.convergence.x}   a fraction shown as a percentage, 1 decimal
  {lighter:facts.a.mass|facts.b.mass} whole-percent reduction of a against b

Literal numbers are allowed only where they restate the frozen requirement or the recorder's own on-screen caption
(tests/test_english_cut.py checks this). Zoom crops are taken from the same source frames. Needs ffmpeg and Pillow.
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOKEN = re.compile(r"\{(?:(um|pct1|lighter):)?([A-Za-z0-9_.|]+)\}")


def lookup(receipt, path):
    value = receipt
    for key in path.split("."):
        if not isinstance(value, dict) or key not in value:
            raise KeyError(f"receipt has no {path}")
        value = value[key]
    return value


def resolve(text, receipt):
    """Replace every {…} token with a value read from the receipt. Unknown paths raise."""
    def one(m):
        fmt, path = m.group(1), m.group(2)
        if fmt == "lighter":
            a, b = (float(lookup(receipt, p)) for p in path.split("|"))
            return str(round((1 - a / b) * 100))
        v = lookup(receipt, path)
        if fmt == "um":
            return f"{float(v) * 1000:.2f}"
        if fmt == "pct1":
            return f"{float(v) * 100:.1f}"
        return str(v)
    return TOKEN.sub(one, text)


def resolved_segments(spec, receipt):
    out = []
    for seg in spec["segments"]:
        s = dict(seg)
        for key in ("step", "headline", "detail"):
            s[key] = resolve(seg.get(key, ""), receipt)
        s["evidence"] = [dict(row, text=resolve(row["text"], receipt)) for row in seg.get("evidence", [])]
        out.append(s)
    return out


def load(spec_path):
    spec = json.loads(Path(spec_path).read_text())
    receipt = json.loads((ROOT / spec["receipt"]).read_text())
    return spec, receipt, resolved_segments(spec, receipt)


def font(candidates, size):
    from PIL import ImageFont
    for c in candidates:
        try:
            return ImageFont.truetype(c, size)
        except OSError:
            continue
    raise SystemExit(f"none of these fonts exist: {candidates}")


REGULAR = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"]
BOLD = ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]
COLOURS = {None: (240, 244, 248), "red": (255, 123, 114), "green": (63, 185, 80), "amber": (240, 180, 60), "dim": (175, 186, 196)}


def render(spec, segments, output):
    from PIL import Image, ImageDraw
    W, H = 1920, 1080
    src = ROOT / spec["video"]
    crop = spec["crop"]                             # [w, h] of the UI region kept, from the top-left corner
    VW, VH = round(crop[0] * spec["scale"]), round(crop[1] * spec["scale"])
    F = {k: font(BOLD if b else REGULAR, s) for k, (b, s) in
         {"step": (1, 28), "head": (1, 42), "detail": (0, 32), "small": (0, 26), "label": (0, 30), "value": (1, 34), "big": (1, 46)}.items()}
    ORANGE, BG = (250, 98, 1), (12, 18, 22)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        parts = []
        for i, seg in enumerate(segments):
            im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            d = ImageDraw.Draw(im)
            d.rectangle([VW, 0, W, VH], fill=BG + (255,))
            x0, y = VW + 36, 96
            d.text((x0, 40), "EVIDENCE", font=F["step"], fill=ORANGE)
            for row in seg["evidence"]:
                f = F[row.get("size", "label")]
                d.text((x0, y), row["text"], font=f, fill=COLOURS[row.get("colour", "dim" if row.get("size", "label") in ("label", "small") else None)])
                y += f.size + 22
            if seg.get("zoom"):
                z = seg["zoom"]
                frame = tmp / f"z{i}.png"
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(z["at"]), "-i", str(src), "-frames:v", "1", str(frame)], check=True)
                zi = Image.open(frame).convert("RGB").crop(tuple(z["box"]))
                zi = zi.resize((int(zi.width * z.get("scale", 1.45)), int(zi.height * z.get("scale", 1.45))), Image.LANCZOS)
                y = max(y + 20, 520)
                d.text((x0, y), "zoom: measured | limit", font=F["small"], fill=COLOURS["dim"])
                zx = VW + (W - VW - zi.width) // 2
                im.paste(zi, (zx, y + 40))
                d.rectangle([zx - 3, y + 37, zx + zi.width + 2, y + 42 + zi.height], outline=ORANGE + (255,), width=3)
            speed = seg["speed"]
            tag = "real time" if speed == 1 else f"played {speed:g}x"
            tw = d.textlength(tag, font=F["step"])
            d.rounded_rectangle([W - 40 - tw - 28, VH - 70, W - 40, VH - 26], radius=10, outline=(120, 130, 140, 255), width=2)
            d.text((W - 40 - tw - 14, VH - 64), tag, font=F["step"], fill=COLOURS["dim"])
            d.rectangle([0, VH, W, H], fill=BG + (250,))
            d.rectangle([0, VH, 14, H], fill=ORANGE + (255,))
            d.text((60, VH + 18), seg["step"], font=F["step"], fill=ORANGE)
            d.text((60, VH + 60), seg["headline"], font=F["head"], fill=COLOURS[seg.get("colour")])
            d.text((60, VH + 122), seg["detail"], font=F["detail"], fill=COLOURS["dim"])
            d.text((W - 40 - d.textlength(spec["source_line"], font=F["small"]), H - 44), spec["source_line"], font=F["small"], fill=(120, 130, 140))
            ov = tmp / f"ov{i}.png"
            im.save(ov)
            part = tmp / f"p{i:02d}.mp4"
            a, b = seg["source"]
            vf = (f"[0:v]trim=start={a}:end={b},setpts=(PTS-STARTPTS)/{speed},crop={crop[0]}:{crop[1]}:0:0,scale={VW}:{VH}:flags=lanczos,"
                  f"pad={W}:{H}:0:0:color=0x0c1216,fps=30[v];[v][1:v]overlay=0:0[o]")
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-i", str(ov), "-filter_complex", vf, "-map", "[o]", "-an",
                            "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", str(part)], check=True)
            parts.append(part)
        (tmp / "list.txt").write_text("".join(f"file '{p}'\n" for p in parts))
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(tmp / "list.txt"), "-c", "copy",
                        "-movflags", "+faststart", str(output)], check=True)


def main(argv):
    if len(argv) != 3:
        raise SystemExit(__doc__)
    spec, receipt, segments = load(argv[1])
    if argv[2] == "--check":
        for s in segments:
            print(f"{s['source'][0]:>6}-{s['source'][1]:<6} {s['speed']:>4}x  {s['headline']}")
        return
    render(spec, segments, argv[2])
    print(argv[2])


if __name__ == "__main__":
    main(sys.argv)
