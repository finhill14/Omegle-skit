#!/usr/bin/env python3
"""
process.py — Full pipeline: merge source+recording, caption, upload to Drive.

Modes:
  1. Local files:   python process.py source.mp4 recording.mp4
  2. From Drive:    python process.py --drive
     (downloads pairs from Omegle Source + Omegle Complete, merges, captions,
      uploads to Omegle Finished)

Requires:
  pip install openai-whisper requests
  ffmpeg installed locally
  For --drive mode: env vars GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
"""

import argparse
import json
import os
import subprocess
import sys

DRIVE_API = "https://www.googleapis.com/drive/v3"
UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))


# ─── FFmpeg merge ──────────────────────────────────────────
def merge_videos(source_path, recording_path, output_path, mute_regions=None):
    top_h, bottom_h = 768, 1152
    video_filter = (
        f"[0:v]scale=1080:{top_h}:force_original_aspect_ratio=increase,"
        f"crop=1080:{top_h},setsar=1[top];"
        f"[1:v]scale=1080:{bottom_h}:force_original_aspect_ratio=increase,"
        f"crop=1080:{bottom_h},setsar=1[bottom];"
        f"[top][bottom]vstack=inputs=2[v]"
    )

    if mute_regions:
        expr = "+".join(f"between(t,{r['start']},{r['end']})" for r in mute_regions)
        audio_filter = (
            f"[0:a]volume='if({expr},0,1)':eval=frame[sa];"
            f"[sa][1:a]amix=inputs=2:duration=shortest[a]"
        )
    else:
        audio_filter = "[0:a][1:a]amix=inputs=2:duration=shortest[a]"

    # Attempt 1: full merge with both audio tracks
    cmd = [
        "ffmpeg", "-y", "-i", source_path, "-i", recording_path,
        "-filter_complex", video_filter + ";" + audio_filter,
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k",
        "-shortest", "-movflags", "+faststart",
        output_path,
    ]
    print(f"  Merging with both audio tracks…")
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode == 0:
        return True

    # Attempt 2: recording audio only
    cmd2 = [
        "ffmpeg", "-y", "-i", source_path, "-i", recording_path,
        "-filter_complex", video_filter,
        "-map", "[v]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k",
        "-shortest", "-movflags", "+faststart",
        output_path,
    ]
    print(f"  Retrying with recording audio only…")
    result = subprocess.run(cmd2, capture_output=True)
    if result.returncode == 0:
        return True

    print(f"  FFmpeg failed:\n{result.stderr.decode(errors='replace')}")
    return False


# ─── Drive helpers ─────────────────────────────────────────
def get_token():
    import requests
    res = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": os.environ["GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
            "refresh_token": os.environ["GOOGLE_REFRESH_TOKEN"],
            "grant_type": "refresh_token",
        },
    )
    res.raise_for_status()
    return res.json()["access_token"]


def find_folder(token, name):
    import requests
    params = {
        "q": f"name='{name}' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        "fields": "files(id)", "spaces": "drive",
    }
    res = requests.get(f"{DRIVE_API}/files", params=params,
                       headers={"Authorization": f"Bearer {token}"})
    res.raise_for_status()
    files = res.json().get("files", [])
    return files[0]["id"] if files else None


def create_folder(token, name):
    import requests
    res = requests.post(f"{DRIVE_API}/files",
                        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                        json={"name": name, "mimeType": "application/vnd.google-apps.folder"})
    res.raise_for_status()
    return res.json()["id"]


def list_videos(token, folder_id, fields="files(id,name)"):
    import requests
    params = {
        "q": f"'{folder_id}' in parents and mimeType contains 'video/' and trashed=false",
        "fields": fields, "orderBy": "name", "pageSize": "100",
    }
    res = requests.get(f"{DRIVE_API}/files", params=params,
                       headers={"Authorization": f"Bearer {token}"})
    res.raise_for_status()
    return res.json().get("files", [])


def download_file(token, file_id, dest):
    import requests
    res = requests.get(f"{DRIVE_API}/files/{file_id}", params={"alt": "media"},
                       headers={"Authorization": f"Bearer {token}"}, stream=True)
    res.raise_for_status()
    with open(dest, "wb") as f:
        for chunk in res.iter_content(chunk_size=8192):
            f.write(chunk)


def upload_file(token, filepath, name, folder_id):
    import requests
    init_res = requests.post(
        f"{UPLOAD_API}/files?uploadType=resumable",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json",
                 "X-Upload-Content-Type": "video/mp4"},
        data=json.dumps({"name": name, "parents": [folder_id], "mimeType": "video/mp4"}),
    )
    init_res.raise_for_status()
    with open(filepath, "rb") as f:
        res = requests.put(init_res.headers["Location"], data=f,
                           headers={"Content-Type": "video/mp4"})
    res.raise_for_status()


def delete_file(token, file_id):
    import requests
    requests.delete(f"{DRIVE_API}/files/{file_id}",
                    headers={"Authorization": f"Bearer {token}"}).raise_for_status()


# ─── Pair matching ─────────────────────────────────────────
def match_pairs(source_files, complete_files):
    source_map = {}
    for f in source_files:
        base = os.path.splitext(f["name"])[0]
        mute_regions = []
        try:
            desc = f.get("description", "")
            if desc:
                parsed = json.loads(desc)
                if isinstance(parsed.get("muteRegions"), list):
                    mute_regions = parsed["muteRegions"]
        except Exception:
            pass
        source_map[base] = {**f, "muteRegions": mute_regions}

    pairs = []
    for f in complete_files:
        if not f["name"].startswith("raw_"):
            continue
        without_ext = os.path.splitext(f["name"])[0]
        without_raw = without_ext[4:]  # strip 'raw_'

        matched_source = None
        username = None
        for base, src in source_map.items():
            if without_raw == base:
                matched_source, username = src, ""
            elif without_raw.endswith("_" + base):
                matched_source = src
                username = without_raw[: len(without_raw) - len(base) - 1]
            if matched_source:
                break

        if matched_source:
            pairs.append({
                "source": matched_source,
                "recording": f,
                "username": username or "unknown",
            })

    return pairs


# ─── Local mode ────────────────────────────────────────────
def run_local(source_path, recording_path, output):
    base = os.path.splitext(os.path.basename(source_path))[0]
    merged_path = os.path.join(SCRIPT_DIR, f"_merged_{base}.mp4")
    final_path = output or os.path.splitext(source_path)[0] + "_final.mp4"

    print(f"Merging: {source_path} + {recording_path}")
    if not merge_videos(source_path, recording_path, merged_path):
        sys.exit(1)

    print(f"Captioning: {merged_path}")
    caption_script = os.path.join(SCRIPT_DIR, "autocaption.py")
    result = subprocess.run(
        [sys.executable, caption_script, merged_path, "--model", "base", "-o", final_path],
        capture_output=True, text=True,
    )
    print(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        sys.exit(result.returncode)

    # Clean up intermediate
    os.unlink(merged_path)
    ass_path = os.path.splitext(merged_path)[0] + ".ass"
    if os.path.exists(ass_path):
        os.unlink(ass_path)

    print(f"\nDone: {final_path}")


# ─── Drive mode ────────────────────────────────────────────
def run_drive():
    token = get_token()

    source_id = find_folder(token, "Omegle Source")
    complete_id = find_folder(token, "Omegle Complete")
    if not source_id or not complete_id:
        print("Required Drive folders not found.")
        return

    finished_id = find_folder(token, "Omegle Finished")
    if not finished_id:
        finished_id = create_folder(token, "Omegle Finished")
        print("Created 'Omegle Finished' folder")

    source_files = list_videos(token, source_id, "files(id,name,mimeType,description)")
    complete_files = list_videos(token, complete_id)
    pairs = match_pairs(source_files, complete_files)

    if not pairs:
        print("No unprocessed pairs found.")
        return

    print(f"Found {len(pairs)} pair(s) to process\n")
    failures = 0

    for pair in pairs:
        src = pair["source"]
        rec = pair["recording"]
        user = pair["username"]
        base = os.path.splitext(src["name"])[0]

        print(f"{'=' * 60}")
        print(f"Source: {src['name']}  |  Recording: {rec['name']}  |  User: {user}")

        src_path = os.path.join(SCRIPT_DIR, src["name"])
        rec_path = os.path.join(SCRIPT_DIR, rec["name"])
        merged_path = os.path.join(SCRIPT_DIR, f"skit_{user}_{base}.mp4")
        captioned_path = os.path.join(SCRIPT_DIR, f"skit_{user}_{base}_captioned.mp4")

        try:
            print("  Downloading source…")
            download_file(token, src["id"], src_path)
            print("  Downloading recording…")
            download_file(token, rec["id"], rec_path)

            if not merge_videos(src_path, rec_path, merged_path, src.get("muteRegions")):
                failures += 1
                continue

            print("  Captioning…")
            caption_script = os.path.join(SCRIPT_DIR, "autocaption.py")
            result = subprocess.run(
                [sys.executable, caption_script, merged_path, "--model", "base",
                 "-o", captioned_path],
                capture_output=True, text=True,
            )
            print(result.stdout)
            if result.returncode != 0:
                print(f"  Caption failed:\n{result.stderr}")
                failures += 1
                continue

            if not os.path.exists(captioned_path):
                print("  Output file not found")
                failures += 1
                continue

            token = get_token()
            print("  Uploading to Omegle Finished…")
            upload_name = f"skit_{user}_{base}_captioned.mp4"
            upload_file(token, captioned_path, upload_name, finished_id)
            print(f"  Done: {upload_name}")

        finally:
            for p in [src_path, rec_path, merged_path, captioned_path]:
                if os.path.exists(p):
                    os.unlink(p)
            ass_path = os.path.splitext(merged_path)[0] + ".ass"
            if os.path.exists(ass_path):
                os.unlink(ass_path)

    print(f"\n{'=' * 60}")
    print(f"Finished — {len(pairs) - failures}/{len(pairs)} succeeded")
    if failures:
        sys.exit(1)


# ─── Main ─────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Merge + caption omegle skit videos")
    parser.add_argument("source", nargs="?", help="Source video file (local mode)")
    parser.add_argument("recording", nargs="?", help="Recording video file (local mode)")
    parser.add_argument("-o", "--output", help="Output path (local mode)")
    parser.add_argument("--drive", action="store_true",
                        help="Process all pairs from Google Drive")
    args = parser.parse_args()

    if args.drive:
        run_drive()
    elif args.source and args.recording:
        run_local(args.source, args.recording, args.output)
    else:
        parser.print_help()
        print("\nExamples:")
        print("  python process.py source.mp4 recording.mp4")
        print("  python process.py source.mp4 recording.mp4 -o output.mp4")
        print("  python process.py --drive")


if __name__ == "__main__":
    main()
