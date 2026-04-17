# Omegle Skit Studio

Split-screen omegle-style skit creator. Source videos load from YOUR Google Drive, your OFM models record responses via webcam (no sign-in required), finished 9:16 skits save back to YOUR Drive.

## Architecture

- **One-time OAuth setup** by the owner — produces a refresh token stored as a Vercel env var
- **Models access the app without signing in** — the server uses your refresh token to get fresh access tokens on demand
- **Client-side video merging** with FFmpeg WASM (no server compute)
- **All Drive operations** happen directly from the browser using short-lived access tokens

## Setup

### 1. Google Cloud Console

1. Create (or use existing) project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the **Google Drive API**
3. Go to **Credentials → Create Credentials → OAuth 2.0 Client ID**
4. Application type: **Web application**
5. Add authorized redirect URI: `https://your-app.vercel.app/api/auth/callback`
6. Copy the **Client ID** and **Client Secret**

### 2. Deploy to Vercel

1. Push this repo to GitHub, import in [vercel.com](https://vercel.com)
2. Add environment variables:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
3. Deploy

### 3. Get Your Refresh Token (one-time, 30 seconds)

1. Open `https://your-app.vercel.app` — you'll see "First-Time Setup"
2. Click **Sign in to Set Up** and sign in with YOUR Google account (the one with the Drive folders)
3. You'll see a page with your refresh token — copy it
4. Back in Vercel: **Settings → Environment Variables**
5. Add: `GOOGLE_REFRESH_TOKEN` = (paste the token)
6. Go to **Deployments** → click "..." on latest → **Redeploy**

Done. Anyone who visits the app now uses YOUR Drive without needing to sign in.

### 4. Prepare Your Drive

1. In your Google Drive, create a folder called **"Omegle Source"**
2. Upload your pre-recorded omegle videos (the guy's half) into it
3. The app auto-creates an **"Omegle Complete"** folder for finished skits

## Model Workflow

Your models just visit the URL. No sign-in, no setup. They:

1. See the first source video at the top of the screen
2. Hit **Record** — the video plays, they respond into the webcam
3. Preview the 9:16 split-screen result
4. Approve — it merges in-browser and saves to your "Omegle Complete" folder
5. Auto-advances to the next video, skipping any already-completed ones

## Project Structure

```
├── api/auth/
│   ├── google.js      # Start OAuth flow (owner setup only)
│   ├── callback.js    # Display refresh token after setup
│   └── refresh.js     # Returns fresh access tokens from env var refresh token
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js      # All frontend logic + FFmpeg WASM
├── vercel.json
└── package.json
```

## Technical Notes

- **Video format**: 1080×1920 H.264/AAC MP4 — scales each input to fit 1080×960 with black bar letterboxing
- **Merge**: Happens in the browser via FFmpeg WASM (~30MB first load, cached after)
- **Audio**: Mixes both tracks; falls back to webcam-only audio if source has none. Recommend headphones during recording to prevent echo.
- **Tokens**: Access tokens are never stored client-side long-term; they expire in 1 hour and are re-fetched as needed from the server

## Environment Variables

| Variable | Where to get it |
|---|---|
| `GOOGLE_CLIENT_ID` | Google Cloud Console → OAuth client |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console → OAuth client |
| `GOOGLE_REFRESH_TOKEN` | Generated once via the app's setup flow |
