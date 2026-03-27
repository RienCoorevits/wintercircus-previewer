# Wintercircus VR Previewer

Lightweight browser preview for a 13414x1080 cylindrical projection strip, with a local bridge for native video protocols that browsers cannot read directly.

## What this prototype does

- Wraps a 13414x1080 texture around a cylinder in `three.js`
- Runs in desktop browsers and WebXR-capable headsets
- Preserves the 13414:1080 aspect ratio while automatically downscaling the GPU preview texture for browser and headset compatibility
- Accepts preview content from:
  - built-in demo pattern
  - local video file
  - screen capture
  - camera
  - a local WebSocket frame bridge
  - managed `Syphon`, `NDI`, and `Spout` source modes routed through the bridge
- Exposes a stable ingest point for native `Syphon`, `Spout`, and `NDI` adapters

## Why there is a bridge

Browsers do not natively consume `Syphon`, `Spout`, or `NDI`. The practical setup is:

1. A native helper receives `Syphon` or `Spout` or `NDI`.
2. That helper encodes frames to JPEG.
3. The helper pushes frames to `ws://localhost:8787/ingest`.
4. The web app subscribes to `ws://localhost:8787/frames`.

That keeps the browser app simple and lets you swap capture backends without changing the VR renderer.

## Current defaults

- Diameter: `20.00m`
- Height: `5.06m`

## Run it

```bash
npm install
npm run dev:all
```

Then open the local Vite URL shown in the terminal.

## Immediate workflows

### Desktop preview

1. Leave the source on `Demo test pattern`, or switch to `Local video file`.
2. Set the physical cylinder `Diameter (m)` and `Height (m)`.
3. Check `Derived Coverage` to see whether the strip wraps a full or partial cylinder.

### VR preview

1. Open the app in a WebXR-capable browser.
2. Click `Enter VR`.
3. Stand at the cylinder center. The camera starts at roughly 1.7m eye height.

### Feed an arbitrary FFmpeg input

Start the app and bridge first:

```bash
npm run dev:all
```

In a second terminal, push any FFmpeg-readable input into the bridge:

```bash
npm run bridge:ffmpeg -- --label "Edit Feed" -- -re -stream_loop -1 -i /path/to/render.mov
```

If your FFmpeg build supports a protocol directly, the same bridge script can ingest it.

Example for NDI on an FFmpeg build compiled with `libndi_newtek`:

```bash
npm run bridge:ffmpeg -- --label "NDI Feed" -- -f libndi_newtek -i "Your NDI Source Name"
```

## Managed protocol sources

The app now exposes `Syphon`, `NDI`, and `Spout` directly in the source dropdown.

For `Syphon` and `NDI`, the UI now queries the local bridge for currently discoverable sources and presents them in a picker before launch. You can still fall back to a custom source name if needed.

When you click `Apply Source`, the browser sends a launch request to the local bridge:

- `POST http://localhost:8787/control/launch`
- `GET http://localhost:8787/sources`
- `GET http://localhost:8787/health`

That launch path is wired to protocol-specific adapter entry points:

- `npm run bridge:syphon`
- `npm run bridge:ndi`
- `npm run bridge:spout`

Current implementation status:

- `Syphon`: implemented on macOS. The launcher builds a vendored copy of the official `Syphon.framework`, discovers a matching Syphon server, reads frames through `SyphonMetalClient`, JPEG-encodes them, and streams them into the bridge.
- `NDI`: implemented on macOS. The launcher uses the official Apple `NDI SDK`, discovers a matching source, receives frames through `NDIlib_recv_capture_v2`, JPEG-encodes them, and streams them into the bridge.
- `Spout`: bridge-managed scaffold only. Native capture implementation still needs to be completed on Windows.

## Native protocol notes

- `Syphon`: practical on macOS with a small Swift or Objective-C helper using `Syphon.framework`
- `Spout`: practical on Windows with a small C++ helper using the Spout SDK
- `NDI`: implemented on macOS with the official Apple NDI SDK, or usable through a compatible FFmpeg/GStreamer build

Notes and adapter guidance live in:

- [native/syphon/README.md](/Users/u0127995/Documents/Developer/Wintercircus Previewer/native/syphon/README.md)
- [native/spout/README.md](/Users/u0127995/Documents/Developer/Wintercircus Previewer/native/spout/README.md)
- [native/ndi/README.md](/Users/u0127995/Documents/Developer/Wintercircus Previewer/native/ndi/README.md)

## Recommended next step for your edit pipeline

For the first usable version, bridge your edit output through `Syphon` or `NDI`, validate the cylindrical framing in VR, then add a dedicated `Spout` adapter only if you need Windows studio routing.
