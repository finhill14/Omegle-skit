# Omegle Skit Studio

A web-based video response platform for creating split-screen omegle-style skits. Upload a pre-recorded video (the guy's half), record your response via webcam, and export a final 9:16 split-screen video ready for posting.

## How It Works

1. **Upload** - Drop in the pre-recorded omegle video (the other person's side)
2. **Record** - The video plays at the top of your screen while you record your webcam response at the bottom, as if you're on a live call
3. **Preview** - Watch both videos playing simultaneously in a 9:16 split-screen layout
4. **Re-record or Approve** - If it doesn't look right, re-record. When you're happy, hit approve
5. **Export** - The server merges both videos into a single 9:16 (1080x1920) MP4 with the original person on top and your response on the bottom

## Requirements

- **Node.js** 18+
- **FFmpeg** installed and available in PATH (`ffmpeg` and `ffprobe`)
- A modern browser with webcam/mic support (Chrome or Firefox recommended)

## Setup

```bash
# Install dependencies
npm install

# Start the server
npm start
```

The app will be available at `http://localhost:3000`.

## Configuration

- `PORT` - Server port (default: 3000)
- Max upload size: 500MB per video
- Final output: 1080x1920 MP4 (H.264 + AAC)

## Project Structure

```
├── server.js              # Express server entry point
├── routes/
│   ├── upload.js          # Pre-recorded video upload endpoint
│   ├── record.js          # Webcam recording upload endpoint
│   ├── merge.js           # FFmpeg merge trigger endpoint
│   └── status.js          # SSE progress streaming endpoint
├── services/
│   └── ffmpeg.js          # FFmpeg wrapper with progress tracking
├── public/
│   ├── index.html         # Single-page application
│   ├── css/style.css      # Styling
│   └── js/app.js          # Frontend logic
├── uploads/               # Temporary session files (gitignored)
└── output/                # Final merged videos (gitignored)
```

## Technical Details

- **Video merging**: FFmpeg scales each input to fit a 1080x960 box (preserving aspect ratio with black bars), then vertically stacks them into a 1080x1920 output
- **Audio**: Both audio tracks are mixed together. Missing audio tracks are handled automatically with silent filler
- **Recording**: Uses the browser's MediaRecorder API. The webcam recording auto-stops when the pre-recorded video ends
- **Progress**: Real-time merge progress via Server-Sent Events (SSE)
