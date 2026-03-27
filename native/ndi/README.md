# NDI Adapter Notes

## Status

The project now contains a working Swift Package entry point for an NDI adapter on macOS:

```bash
npm run bridge:ndi -- --source "Your NDI Source Name"
```

Current state: implemented. The adapter discovers an NDI source, receives BGRA/BGRX frames through the official Apple NDI SDK, downscales for preview, JPEG-encodes them, and pushes them into the local WebSocket bridge.

## Fastest path

If you already have an `NDI` output in your edit or media server stack, this is the easiest protocol to hook up first because you can often avoid writing custom native code.

## Two viable routes

### FFmpeg route

Use an FFmpeg build compiled with `libndi_newtek`, then pipe frames into the existing bridge:

```bash
npm run bridge:ffmpeg -- --label "NDI Feed" -- -f libndi_newtek -i "Your NDI Source Name"
```

On this machine, the installed FFmpeg build does not expose `libndi_newtek`, so the direct FFmpeg route is not currently available without installing a different build or the NDI SDK/tooling.

### Native route

- Language: Swift
- SDK: official Apple NDI SDK
- Output: JPEG frames over WebSocket

## Adapter loop

1. Discover the target NDI source.
2. Receive frames with `NDIlib_recv_capture_v2`.
3. Resize and JPEG-encode for browser preview.
4. Push binary frames to `/ingest`.
5. Send a JSON `meta` message with source name.
