#!/usr/bin/env python3
"""
process.py — Download merged videos from Drive, run autocaption, upload results.

Reads from "Omegle Merged" folder, captions each video, uploads to
"Omegle Finished", then removes the original from "Omegle Merged".

Requires env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
"""

import json
import os
import subprocess
import sys

import requests

DRIVE_API = "https://www.googleapis.com/drive/v3"
UPLOAD_API = "https://www.googleapis.com/upload/drive/v3"


def get_token():
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
    params = {
        "q": f"name='{name}' and mimeType='application/vnd.google-apps.folder' and trashed=false",
        "fields": "files(id)",
        "spaces": "drive",
    }
    res = requests.get(
        f"{DRIVE_API}/files",
        params=params,
        headers={"Authorization": f"Bearer {token}"},
    )
    res.raise_for_status()
    files = res.json().get("files", [])
    return files[0]["id"] if files else None


def create_folder(token, name):
    res = requests.post(
        f"{DRIVE_API}/files",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json={"name": name, "mimeType": "application/vnd.google-apps.folder"},
    )
    res.raise_for_status()
    return res.json()["id"]


def list_videos(token, folder_id):
    params = {
        "q": f"'{folder_id}' in parents and mimeType contains 'video/' and trashed=false",
        "fields": "files(id,name)",
        "orderBy": "name",
        "pageSize": "100",
    }
    res = requests.get(
        f"{DRIVE_API}/files",
        params=params,
        headers={"Authorization": f"Bearer {token}"},
    )
    res.raise_for_status()
    return res.json().get("files", [])


def download_file(token, file_id, dest):
    res = requests.get(
        f"{DRIVE_API}/files/{file_id}",
        params={"alt": "media"},
        headers={"Authorization": f"Bearer {token}"},
        stream=True,
    )
    res.raise_for_status()
    with open(dest, "wb") as f:
        for chunk in res.iter_content(chunk_size=8192):
            f.write(chunk)


def upload_file(token, filepath, name, folder_id):
    mime = "video/mp4"
    init_res = requests.post(
        f"{UPLOAD_API}/files?uploadType=resumable",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "X-Upload-Content-Type": mime,
        },
        data=json.dumps({"name": name, "parents": [folder_id], "mimeType": mime}),
    )
    init_res.raise_for_status()
    upload_url = init_res.headers["Location"]

    with open(filepath, "rb") as f:
        res = requests.put(upload_url, data=f, headers={"Content-Type": mime})
    res.raise_for_status()
    return res.json()


def delete_file(token, file_id):
    res = requests.delete(
        f"{DRIVE_API}/files/{file_id}",
        headers={"Authorization": f"Bearer {token}"},
    )
    res.raise_for_status()


def main():
    token = get_token()

    merged_id = find_folder(token, "Omegle Merged")
    if not merged_id:
        print("No 'Omegle Merged' folder found. Nothing to process.")
        return

    finished_id = find_folder(token, "Omegle Finished")
    if not finished_id:
        finished_id = create_folder(token, "Omegle Finished")
        print("Created 'Omegle Finished' folder")

    videos = list_videos(token, merged_id)
    if not videos:
        print("No videos in Omegle Merged. Nothing to process.")
        return

    print(f"Found {len(videos)} video(s) to caption\n")
    script_dir = os.path.dirname(os.path.abspath(__file__))
    caption_script = os.path.join(script_dir, "autocaption.py")
    failures = 0

    for video in videos:
        print(f"{'=' * 60}")
        print(f"Processing: {video['name']}")

        local_path = os.path.join(script_dir, video["name"])
        output_path = os.path.splitext(local_path)[0] + "_captioned.mp4"
        ass_path = os.path.splitext(local_path)[0] + ".ass"

        try:
            print("  Downloading…")
            download_file(token, video["id"], local_path)

            print("  Captioning…")
            result = subprocess.run(
                [sys.executable, caption_script, local_path, "--model", "base"],
                capture_output=True,
                text=True,
            )
            print(result.stdout)
            if result.returncode != 0:
                print(f"  Caption failed:\n{result.stderr}")
                failures += 1
                continue

            if not os.path.exists(output_path):
                print(f"  Output file not found: {output_path}")
                failures += 1
                continue

            # Refresh token in case processing took a while
            token = get_token()

            print("  Uploading captioned video…")
            upload_name = os.path.splitext(video["name"])[0] + "_captioned.mp4"
            upload_file(token, output_path, upload_name, finished_id)

            # Remove processed file from Omegle Merged
            delete_file(token, video["id"])
            print(f"  Done: {upload_name}")

        finally:
            for p in [local_path, output_path, ass_path]:
                if os.path.exists(p):
                    os.unlink(p)

    print(f"\n{'=' * 60}")
    print(f"Finished — {len(videos) - failures}/{len(videos)} succeeded")
    if failures:
        sys.exit(1)


if __name__ == "__main__":
    main()
