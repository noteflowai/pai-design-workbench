"""Render the recorded demo for publication.

Usage: python3 tools/render_demo.py <recording-dir> <output-dir> [highlight-start-source-seconds]

Spans where the screen is visually static (waiting for native Blender/CadQuery work) are detected with
ffmpeg freezedetect and played 6x faster after their first 0.6 s; everything else stays real-time. Nothing
is cut or reordered. Outputs demo.mp4 (H.264), demo.gif (live CAD build highlight, 960 px) and poster.png.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

src_dir, out_dir = Path(sys.argv[1]), Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)
video = next(src_dir.glob("*.webm"))
run = lambda *a, **k: subprocess.run(list(a), check=True, **k)
duration = float(run("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video), capture_output=True, text=True).stdout)

log = run("ffmpeg", "-v", "info", "-i", str(video), "-vf", "freezedetect=n=0.006:d=1.5", "-map", "0:v", "-f", "null", "-", capture_output=True, text=True).stderr
starts = [float(x) for x in re.findall(r"freeze_start: ([\d.]+)", log)]
ends = [float(x) for x in re.findall(r"freeze_end: ([\d.]+)", log)] + [duration]
frozen = []
for a, b in zip(starts, ends):
    if frozen and a - frozen[-1][1] < 0.15: frozen[-1][1] = b
    else: frozen.append([a, b])
# Only long waits (native builds, model calls) are accelerated; caption reading time stays real-time.
SPEED, KEEP, MIN_FROZEN = 6.0, 2.5, 4.0
spans, cursor = [], 0.0
for a, b in frozen:
    a = max(a + KEEP, cursor)
    if b - a < MIN_FROZEN - KEEP: continue
    if a > cursor: spans.append((cursor, a, 1.0))
    spans.append((a, b, SPEED)); cursor = b
if cursor < duration: spans.append((cursor, duration, 1.0))
out_time = lambda t: sum((min(t, b) - a) / s for a, b, s in spans if t > a)

# Each span is encoded on its own (fast seek), then joined losslessly with the concat demuxer.
import tempfile
with tempfile.TemporaryDirectory() as tmp:
    parts = []
    for n, (a, b, sp) in enumerate(spans):
        part = Path(tmp) / f"p{n:03d}.mp4"
        run("ffmpeg", "-v", "error", "-y", "-ss", f"{a:.3f}", "-to", f"{b:.3f}", "-i", str(video), "-vf", f"setpts=(PTS-STARTPTS)/{sp},fps=25,scale=1280:-2:flags=lanczos",
            "-an", "-c:v", "libx264", "-preset", "medium", "-crf", "27", "-pix_fmt", "yuv420p", "-g", "50", str(part))
        parts.append(part)
    end_card = src_dir / "endcard.png"
    if end_card.exists():
        # The recorder's final frames are lost on close; the end card (a screenshot of the same overlay) holds 5 s with a fade-in.
        part = Path(tmp) / "zz-end.mp4"
        run("ffmpeg", "-v", "error", "-y", "-loop", "1", "-t", "5", "-i", str(end_card), "-vf", "fps=25,scale=1280:-2:flags=lanczos,fade=t=in:st=0:d=0.6,format=yuv420p",
            "-c:v", "libx264", "-preset", "medium", "-crf", "27", "-g", "50", str(part))
        parts.append(part)
    (Path(tmp) / "list.txt").write_text("".join(f"file '{p}'\n" for p in parts))
    run("ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(Path(tmp) / "list.txt"), "-c", "copy", "-movflags", "+faststart", str(out_dir / "demo.mp4"))

# First native geometry: the dark viewport centre gets noticeably brighter once the part is drawn.
probe = run("ffmpeg", "-v", "error", "-i", str(video), "-vf", "fps=2,crop=420:200:420:420,scale=42:20,format=gray", "-f", "rawvideo", "-", capture_output=True).stdout
frames = [probe[i:i + 840] for i in range(0, len(probe) - 839, 840)]
means = [sum(f) / len(f) for f in frames]
# Empty viewport ≈ uniform dark; after ≥3 s of it, the first frame that changes but stays dark-ish is the first geometry.
first, run_start = 30.0, None
for i, m in enumerate(means):
    if m < 45 and run_start is None: run_start = i
    elif run_start is not None and i - run_start >= 6 and abs(m - means[run_start]) >= 4 and m < 150: first = i / 2; break
    elif m >= 45: run_start = None
# An explicit highlight start (source seconds, e.g. from the recorder's marks.json) overrides the heuristic.
if len(sys.argv) > 3: first = float(sys.argv[3])
gif_start = out_time(max(0, first - 2))
run("ffmpeg", "-v", "error", "-y", "-ss", f"{gif_start:.2f}", "-t", "40", "-i", str(out_dir / "demo.mp4"), "-filter_complex",
    "[0:v]setpts=PTS/1.6,fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4",
    str(out_dir / "demo.gif"))
# Poster: the title card, fully faded in.
run("ffmpeg", "-v", "error", "-y", "-ss", "3.0", "-i", str(out_dir / "demo.mp4"), "-frames:v", "1", str(out_dir / "poster.png"))
total = float(run("ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out_dir / "demo.mp4"), capture_output=True, text=True).stdout)
print(json.dumps({"source": video.name, "sourceSeconds": round(duration, 1), "outputSeconds": round(total, 1), "acceleratedSpans": sum(1 for s in spans if s[2] > 1),
                  "firstGeometrySourceSeconds": first, "outputs": {p.name: p.stat().st_size for p in out_dir.iterdir() if p.suffix in (".mp4", ".gif", ".png")}}))
