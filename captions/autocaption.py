#!/usr/bin/env python3
"""
autocaption.py — Free, local video auto-captioning with word highlighting
Uses OpenAI Whisper (runs on your machine) + FFmpeg to burn styled subtitles.

Requirements:
    pip install openai-whisper
    ffmpeg  (brew install ffmpeg / apt install ffmpeg / ffmpeg.org for Windows)

Usage:
    python autocaption.py input.mp4
    python autocaption.py input.mp4 --model medium
    python autocaption.py input.mp4 --highlight yellow
    python autocaption.py input.mp4 --style box      # opaque-box bg (original look)
    python autocaption.py input.mp4 --style extrude  # 3-D extruded text (default)
    python autocaption.py input.mp4 --no-burn        # just produce the .ass file
    python autocaption.py input.mp4 --font path/to/MyFont.ttf
"""

import argparse
import os
import re
import sys
import subprocess
import textwrap

# ── Highlight colour presets (ASS format: &HAABBGGRR) ───────────────────────
HIGHLIGHT_COLORS = {
    "green":  "&H0000FF00",   # lime green — classic TikTok style
    "yellow": "&H0000FFFF",   # yellow
    "cyan":   "&H00FFFF00",   # cyan
    "pink":   "&H00B469FF",   # hot pink
}

WHITE  = "&H00FFFFFF"
BLACK  = "&H00000000"
BOX_BG = "&HCC000000"        # ~80% opaque black box behind text


# ── Helpers ──────────────────────────────────────────────────────────────────

def ts(seconds: float) -> str:
    """Float seconds → ASS timestamp  H:MM:SS.cc"""
    cs = round(seconds * 100)
    h  = cs // 360000;  cs %= 360000
    m  = cs // 6000;    cs %= 6000
    s  = cs // 100;     cs %= 100
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def seconds_to_srt_ts(s: float) -> str:
    ms = int((s % 1) * 1000)
    s  = int(s)
    h  = s // 3600;  s %= 3600
    m  = s // 60;    s %= 60
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def install_font(font_path: str) -> str:
    """
    Copy a TTF to ~/.fonts so fontconfig and FFmpeg/libass can find it.
    Returns the font family name to use in the ASS Style line.
    """
    import shutil, pathlib
    fonts_dir = pathlib.Path.home() / ".fonts"
    fonts_dir.mkdir(exist_ok=True)
    dest = fonts_dir / pathlib.Path(font_path).name
    if not dest.exists():
        shutil.copy(font_path, dest)
        subprocess.run(["fc-cache", "-f", str(fonts_dir)], capture_output=True)

    # Try reading family name from the TTF metadata
    try:
        from fontTools.ttLib import TTFont
        for record in TTFont(str(dest))["name"].names:
            if record.nameID == 1:
                return record.toUnicode()
    except Exception:
        pass

    # Fallback: strip style suffixes from filename
    name = pathlib.Path(font_path).stem
    return re.sub(r"[-_](Bold|Italic|Regular|Medium|Black|Heavy|Light).*", "", name, flags=re.I)


def build_ass(segments, highlight_color: str, font_name: str, font_size: int, style: str = "extrude", res_x: int = 1080, res_y: int = 1920) -> str:
    """
    Convert Whisper word-timestamp segments into an ASS file where the
    current word is shown in highlight_color; the rest of the line is white.
    style="extrude"  → thick outline + hard drop-shadow (3-D look, default)
    style="box"      → opaque black box behind the text (original look)
    """
    hi = HIGHLIGHT_COLORS.get(highlight_color, HIGHLIGHT_COLORS["green"])

    # ── Per-style ASS parameters ─────────────────────────────────────────────
    if style == "extrude":
        # BorderStyle 1 = outline + drop-shadow (libass renders shadow without
        # blur by default, giving the hard offset we want for 3-D extrusion).
        border_style = 1
        outline_px   = 6          # thick outline for the "wall" of the extrusion
        shadow_px    = 6          # hard offset to fake depth (no blur)
        spacing      = 2          # slight letter spacing reads better with thick borders
        back_color   = BLACK      # opaque black shadow colour
    else:                         # "box"
        border_style = 4
        outline_px   = 0
        shadow_px    = 0
        spacing      = 2
        back_color   = BOX_BG

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {res_x}\n"
        f"PlayResY: {res_y}\n"
        "WrapStyle: 1\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{font_name},{font_size},{WHITE},{WHITE},{BLACK},{back_color},"
        f"-1,0,0,0,100,100,{spacing},0,{border_style},{outline_px},{shadow_px},5,20,20,60,1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    events = []
    PHRASE_MAX = 5  # max words shown on screen at once

    # Pin captions slightly above the video's vertical center — 47% down from top.
    # With Style Alignment=5 (middle-center), \pos(x,y) anchors the text center at (x,y).
    pos = "{\\pos(" + str(res_x // 2) + "," + str(int(res_y * 0.47)) + ")}"

    for seg in segments:
        words = seg.get("words", [])

        if not words:
            # No word timestamps — plain segment line, no highlight
            text = seg["text"].strip().upper()
            text = "\\N".join(textwrap.wrap(text, 40))
            events.append(
                f"Dialogue: 0,{ts(seg['start'])},{ts(seg['end'])},"
                f"Default,,0,0,0,,{pos}{text}"
            )
            continue

        # Split segment into short on-screen phrases
        for chunk_start in range(0, len(words), PHRASE_MAX):
            phrase = words[chunk_start : chunk_start + PHRASE_MAX]
            phrase_end = phrase[-1]["end"]
            raw_words  = [w["word"].strip().upper() for w in phrase]

            # One Dialogue event per word: that word highlighted, rest white
            for wi, word_info in enumerate(phrase):
                word_start = word_info["start"]
                word_end   = (phrase[wi + 1]["start"]
                              if wi + 1 < len(phrase) else phrase_end)

                parts = []
                for j, w in enumerate(raw_words):
                    if j == wi:
                        parts.append(f"{{\\1c{hi}}}{w}{{\\1c{WHITE}}}")
                    else:
                        parts.append(w)

                events.append(
                    f"Dialogue: 0,{ts(word_start)},{ts(word_end)},"
                    f"Default,,0,0,0,,{pos}" + " ".join(parts)
                )

    return header + "\n".join(events) + "\n"


def segments_to_srt(segments) -> str:
    lines = []
    for i, seg in enumerate(segments, 1):
        start = seconds_to_srt_ts(seg["start"])
        end   = seconds_to_srt_ts(seg["end"])
        text  = "\n".join(textwrap.wrap(seg["text"].strip(), 42))
        lines.append(f"{i}\n{start} --> {end}\n{text}\n")
    return "\n".join(lines)


def run(cmd, cwd=None):
    result = subprocess.run(cmd, stderr=subprocess.PIPE, cwd=cwd)
    if result.returncode != 0:
        print(result.stderr.decode(errors="replace"), file=sys.stderr)
        sys.exit(result.returncode)


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Auto-caption a video — word-by-word highlight style, free & local"
    )
    parser.add_argument("input",               help="Input video (mp4, mov, mkv…)")
    parser.add_argument("--output",   "-o",    help="Output path (default: input_captioned.mp4)")
    parser.add_argument("--model",    "-m",    default="base",
                        choices=["tiny", "base", "small", "medium", "large"],
                        help="Whisper model. 'base' = fast & good. 'medium' = more accurate.")
    parser.add_argument("--highlight", "-c",   default="green",
                        choices=list(HIGHLIGHT_COLORS.keys()),
                        help="Highlight colour for the active word (default: green)")
    parser.add_argument("--style",     "-s",   default="extrude",
                        choices=["extrude", "box"],
                        help="Caption style: 'extrude' = 3-D thick outline + hard shadow (default); "
                             "'box' = opaque background box (original look)")
    parser.add_argument("--font",     "-f",    default=None,
                        help="Path to a .ttf font file. Montserrat Bold is auto-downloaded if omitted.")
    parser.add_argument("--font-size",         type=int, default=56,
                        help="Caption font size (default: 56)")
    parser.add_argument("--language", "-l",    default=None,
                        help="Language hint e.g. 'en', 'es', 'fr' (auto-detected if omitted)")
    parser.add_argument("--no-burn",           action="store_true",
                        help="Only produce the .ass file, skip video encoding")
    parser.add_argument("--srt",               action="store_true",
                        help="Also save a plain .srt alongside the .ass")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        print(f"❌  File not found: {args.input}")
        sys.exit(1)

    base     = os.path.splitext(args.input)[0]
    ass_path = base + ".ass"
    srt_path = base + ".srt"
    out_path = args.output or (base + "_captioned.mp4")

    # ── Font setup ───────────────────────────────────────────────────────────
    if args.font:
        print(f"🔤  Installing font: {args.font}")
        font_name = install_font(args.font)
        print(f"    Family name: {font_name}")
    else:
        import pathlib, urllib.request
        fonts_dir = pathlib.Path.home() / ".fonts"
        fonts_dir.mkdir(exist_ok=True)
        montserrat = fonts_dir / "Montserrat-Bold.ttf"
        if not montserrat.exists():
            print("🔤  Downloading Montserrat Bold…")
            url = ("https://github.com/JulietaUla/Montserrat/raw/master"
                   "/fonts/ttf/Montserrat-Bold.ttf")
            try:
                urllib.request.urlretrieve(url, montserrat)
                subprocess.run(["fc-cache", "-f", str(fonts_dir)], capture_output=True)
                print("    ✅  Font ready")
            except Exception as e:
                print(f"    ⚠️   Download failed ({e}). Falling back to system font.")
                montserrat = None
        font_name = "Montserrat" if (montserrat and montserrat.exists()) else "Arial"

    # ── Transcribe ───────────────────────────────────────────────────────────
    print(f"🎙️  Transcribing with Whisper ({args.model})…")
    try:
        import whisper
    except ImportError:
        print("❌  openai-whisper not installed. Run:  pip install openai-whisper")
        sys.exit(1)

    model  = whisper.load_model(args.model)
    opts   = {"word_timestamps": True, "verbose": False}
    if args.language:
        opts["language"] = args.language

    result   = model.transcribe(args.input, **opts)
    segments = result["segments"]
    print(f"✅  Transcription done — {len(segments)} segments")

    # ── Detect video resolution ─────────────────────────────────────────────
    res_x, res_y = 1080, 1920
    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0",
             args.input],
            capture_output=True, text=True
        )
        if probe.returncode == 0 and "," in probe.stdout.strip():
            w, h = probe.stdout.strip().split(",")[:2]
            res_x, res_y = int(w), int(h)
    except Exception:
        pass

    # ── Generate ASS ─────────────────────────────────────────────────────────
    ass_content = build_ass(segments, args.highlight, font_name, args.font_size, args.style, res_x, res_y)
    with open(ass_path, "w", encoding="utf-8") as f:
        f.write(ass_content)
    print(f"✅  Subtitle file → {ass_path}")

    if args.srt:
        with open(srt_path, "w", encoding="utf-8") as f:
            f.write(segments_to_srt(segments))
        print(f"✅  SRT file → {srt_path}")

    if args.no_burn:
        print("⏭️   --no-burn set. Done.")
        return

    # ── Burn with FFmpeg ──────────────────────────────────────────────────────
    print(f"🎬  Burning captions → {out_path}…")

    # FFmpeg's ass filter is finicky with paths — safest approach is to
    # cd into the directory so we can pass just the filename with no path at all.
    ass_dir      = os.path.abspath(os.path.dirname(ass_path)) or "."
    ass_filename = os.path.basename(ass_path)
    input_abs    = os.path.abspath(args.input)
    output_abs   = os.path.abspath(out_path)

    run([
        "ffmpeg", "-y",
        "-i", input_abs,
        "-vf", f"ass={ass_filename}",
        "-c:a", "copy",
        "-c:v", "libx264",
        "-crf", "18",
        "-preset", "fast",
        output_abs,
    ], cwd=ass_dir)
    print(f"\n🎉  Done!  → {out_path}")


if __name__ == "__main__":
    main()
