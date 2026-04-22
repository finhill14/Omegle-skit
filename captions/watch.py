#!/usr/bin/env python3
"""
watch.py — Watch ~/Downloads for skit_*.zip files and process them automatically.

Run once and leave it running:
    python3 captions/watch.py

When you click Download on the merge page:
  1. ZIP lands in ~/Downloads
  2. This script detects it, extracts it into captions/
  3. Runs process.py on the extracted folder automatically
  4. Moves the zip into captions/ when done
"""

import os
import sys
import time
import zipfile
import subprocess
import pathlib

SCRIPT_DIR = pathlib.Path(__file__).parent.resolve()
DOWNLOADS  = pathlib.Path.home() / "Downloads"
POLL       = 3   # seconds between scans


def wait_stable(path: pathlib.Path, stable_secs: float = 1.5) -> None:
    """Block until file size stops changing (i.e. download is complete)."""
    prev_size = -1
    stable_for = 0.0
    while stable_for < stable_secs:
        try:
            size = path.stat().st_size
        except FileNotFoundError:
            return
        if size == prev_size and size > 0:
            stable_for += 0.5
        else:
            stable_for = 0.0
        prev_size = size
        time.sleep(0.5)


def process_zip(zip_path: pathlib.Path) -> None:
    print(f"\n{'='*60}")
    print(f"Found: {zip_path.name}")

    wait_stable(zip_path)

    # Extract
    try:
        with zipfile.ZipFile(zip_path) as zf:
            # Determine the top-level folder name inside the zip
            names = zf.namelist()
            folder_name = names[0].split("/")[0]
            zf.extractall(SCRIPT_DIR)
    except (zipfile.BadZipFile, OSError) as e:
        print(f"  Could not open zip: {e}")
        return

    folder_path = SCRIPT_DIR / folder_name
    print(f"  Extracted → {folder_path.relative_to(SCRIPT_DIR.parent)}")

    if not folder_path.is_dir():
        print(f"  Expected folder not found: {folder_path}")
        return

    # Run process.py
    print(f"  Running process.py …\n")
    result = subprocess.run(
        [sys.executable, str(SCRIPT_DIR / "process.py"), str(folder_path)],
        cwd=str(SCRIPT_DIR.parent),
    )

    if result.returncode == 0:
        # Success — delete zip entirely
        try:
            zip_path.unlink()
            print(f"\n  Zip deleted.")
        except OSError:
            pass
        captioned = list(folder_path.glob("*_captioned.mp4"))
        if captioned:
            print(f"  Output: {captioned[0].relative_to(SCRIPT_DIR.parent)}")
    else:
        # Failed — move zip to captions/ so it can be inspected / retried
        dest = SCRIPT_DIR / zip_path.name
        try:
            zip_path.rename(dest)
            print(f"\n  Zip kept → captions/{zip_path.name} (processing failed)")
        except Exception:
            pass
        print(f"  process.py exited with code {result.returncode}")


def main():
    if not DOWNLOADS.exists():
        print(f"Downloads folder not found: {DOWNLOADS}")
        sys.exit(1)

    print(f"Watching {DOWNLOADS} for skit_*.zip …")
    print("Press Ctrl+C to stop.\n")

    # Seed with already-existing zips so we don't reprocess them
    seen = {p.name for p in DOWNLOADS.glob("skit_*.zip")}
    if seen:
        print(f"  (ignoring {len(seen)} existing zip(s) already in Downloads)\n")

    while True:
        for zip_path in sorted(DOWNLOADS.glob("skit_*.zip")):
            if zip_path.name not in seen:
                seen.add(zip_path.name)
                process_zip(zip_path)
        time.sleep(POLL)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
