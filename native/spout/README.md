# Spout Adapter Notes

## Status

The project now contains a Windows PowerShell entry point placeholder for a Spout adapter:

```powershell
npm run bridge:spout -- --source "Your Spout Sender"
```

Current state: scaffold only. The bridge can launch it on Windows and report failures/status, but live frame capture is not implemented yet.

## Target

Capture a named `Spout` sender on Windows and forward frames to:

```text
ws://localhost:8787/ingest
```

## Recommended implementation

- Language: C++
- SDK: Spout2
- Output: JPEG frames over a WebSocket client

## Adapter loop

1. Open the selected Spout sender.
2. Read GPU frames into a CPU buffer or shared texture conversion path.
3. Resize if needed.
4. JPEG-encode the preview frame.
5. Push it to the local ingest socket.

## Practical note

`Spout` is Windows-only. If your edit suite is on macOS, focus on `Syphon` or `NDI` first.
