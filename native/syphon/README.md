# Syphon Adapter Notes

## Status

The project now contains a Swift Package entry point for a Syphon adapter:

```bash
npm run bridge:syphon -- --source "Your Syphon Server"
```

Current state: implemented on macOS.

- The launcher script builds a vendored copy of the official `Syphon.framework`
- The adapter discovers the requested server through `SyphonServerDirectory`
- Frames are pulled through `SyphonMetalClient`
- Frames are JPEG-encoded and streamed to `ws://localhost:8787/ingest`

If no matching Syphon server is available, the adapter stays alive and waits for it.

## Target

Capture a named `Syphon` server on macOS and forward frames to:

```text
ws://localhost:8787/ingest
```

## Recommended implementation

- Language: Swift
- Frameworks: `Syphon.framework`, `CoreImage`, `ImageIO`, `Network`
- Output: JPEG frames over a WebSocket client

## Adapter loop

1. Discover the target Syphon server by name.
2. Receive the latest frame as a texture or image.
3. Convert to `CIImage` or `CGImage`.
4. Compress to JPEG at a preview-friendly size.
5. Send binary JPEG frames to `/ingest`.
6. Send a JSON `meta` message when the source changes.

## Reasonable first target

- 2048px or 3072px output width
- 24 or 30 fps
- JPEG quality 0.7 to 0.82

That is usually enough for composition and timing checks in the headset without trying to push the full 13414px strip through the browser.
