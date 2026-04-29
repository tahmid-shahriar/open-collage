# Open Collage

Browser-based video collage editor built with React and Vite.

## Features

- Grid collage layout with independent split controls
- Image + video cells with cover-fit rendering
- Text overlays with animation options
- Export pipeline built on WebCodecs + in-browser MP4 muxing

## Export Format

The app exports MP4 (H.264) using browser WebCodecs (`VideoEncoder`) and an in-browser MP4 muxer.

- Image-only projects export using the configured still duration.
- Mixed image/video projects export to the longest video duration.
- Audio mixing is not yet implemented in this branch.

## Browser Support

MP4 export requires:

- `VideoEncoder` support (WebCodecs API)
- A browser-supported H.264 encoder configuration for your selected resolution/FPS

If your browser cannot satisfy those requirements, export fails during preflight with a clear stage message.

## Development

Install dependencies:

```bash
npm install
```

Run dev server:

```bash
npm run dev
```

Lint:

```bash
npm run lint
```

Build:

```bash
npm run build
```
