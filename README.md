# Omegle Skit Studio

A web app for creating split-screen omegle-style skits. Source videos (the guy's half) are loaded from Google Drive, your models record their webcam response, and the finished 9:16 split-screen video is saved back to Google Drive.

## How It Works

1. **Sign in** with Google to connect your Drive
2. **Source videos** are loaded from the **"Omegle Source"** folder in your Drive
3. **Record** — the source video plays at the top while you record your webcam response at the bottom
4. **Preview** — watch both videos synced in a 9:16 split-screen layout
5. **Approve** — the app merges them in-browser (via FFmpeg WASM) into a single 1080x1920 MP4
6. **Auto-uploads** the finished skit to the **"Omegle Complete"** folder in your Drive
7. **Cycles** to the next video automatically — already-completed videos are skipped

## Setup

### 1. Google Cloud Console

1. Create a project (or use an existing one) at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the **Google Drive API**
3. Go to **Credentials → Create Credentials → OAuth 2.0 Client ID**
4. Application type: **Web application**
5. Add authorized redirect URIs:
   - `https://your-app.vercel.app/api/auth/callback` (production)
   - `http://localhost:3000/api/auth/callback` (local dev)
6. Copy the **Client ID** and **Client Secret**

### 2. Deploy to Vercel

1. Push this repo to GitHub
2. Import the repo in [vercel.com](https://vercel.com)
3. Add environment variables:
   - `GOOGLE_CLIENT_ID` — your OAuth client ID
   - `GOOGLE_CLIENT_SECRET` — your OAuth client secret
4. Deploy

### 3. Prepare Your Drive

1. Open Google Drive
2. Create a folder called **"Omegle Source"**
3. Upload your pre-recorded omegle videos (the guy's half) into that folder
4. The app will auto-create the **"Omegle Complete"** folder for finished skits

### Local Development

```bash
npx vercel env pull .env.local   # pull env vars from Vercel
npx vercel dev                    # runs on http://localhost:3000
```

## Architecture

```
├── api/
│   └── auth/
│       ├── google.js      # Redirects to Google OAuth
│       ├── callback.js    # Exchanges code for tokens
│       └── refresh.js     # Refreshes expired access tokens
├── public/
│   ├── index.html         # Single-page app
│   ├── css/style.css      # Styling
│   └── js/app.js          # All frontend logic
├── vercel.json            # Vercel config
└── package.json
```

**No server-side processing** — video merging happens entirely in the browser using FFmpeg compiled to WebAssembly. The Vercel functions only handle OAuth token exchange.

## Technical Details

- **Video merging**: FFmpeg WASM scales each input to fit a 1080×960 box (black bars for aspect ratio mismatches), then stacks vertically into 1080×1920
- **Audio**: Both audio tracks are mixed. If the source video has no audio, only the webcam audio is used. Recommend headphones during recording to prevent echo
- **Recording**: MediaRecorder API, auto-stops when the source video ends
- **Storage**: Google Drive API v3 — resumable uploads for large files
- **First load**: FFmpeg WASM core is ~30MB (downloaded from CDN, cached by browser after first load)

## Requirements

- Modern browser with WebAssembly support (Chrome, Firefox, Safari 15+)
- Webcam and microphone access
- Google account with Google Drive
