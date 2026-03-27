import { spawn } from "node:child_process";
import process from "node:process";
import WebSocket from "ws";

const args = process.argv.slice(2);
const separatorIndex = args.indexOf("--");
const optionArgs = separatorIndex === -1 ? [] : args.slice(0, separatorIndex);
const ffmpegInputArgs = separatorIndex === -1 ? args : args.slice(separatorIndex + 1);

function readOption(name, fallback) {
  const index = optionArgs.indexOf(name);
  if (index === -1) {
    return fallback;
  }
  return optionArgs[index + 1] || fallback;
}

if (ffmpegInputArgs.length === 0) {
  console.error("Usage: npm run bridge:ffmpeg -- --ws ws://localhost:8787/ingest -- <ffmpeg input args>");
  console.error("Example: npm run bridge:ffmpeg -- -- -re -stream_loop -1 -i /path/to/file.mov");
  process.exit(1);
}

const wsUrl = readOption("--ws", "ws://localhost:8787/ingest");
const fps = readOption("--fps", "30");
const scaleWidth = readOption("--scale", "2048");
const label = readOption("--label", "FFmpeg source");

const socket = new WebSocket(wsUrl);

socket.on("open", () => {
  socket.send(
    JSON.stringify({
      type: "meta",
      label: `${label} (${fps} fps, ${scaleWidth}px wide)`,
    }),
  );

  const ffmpegArgs = [
    ...ffmpegInputArgs,
    "-an",
    "-vf",
    `fps=${fps},scale=${scaleWidth}:-1:flags=lanczos`,
    "-f",
    "image2pipe",
    "-vcodec",
    "mjpeg",
    "-q:v",
    "4",
    "-",
  ];

  console.log(`Launching ffmpeg ${ffmpegArgs.join(" ")}`);

  const ffmpeg = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["ignore", "pipe", "inherit"],
  });

  let pending = Buffer.alloc(0);

  ffmpeg.stdout.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);

    while (true) {
      const start = pending.indexOf(Buffer.from([0xff, 0xd8]));
      if (start === -1) {
        pending = Buffer.alloc(0);
        break;
      }

      const end = pending.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end === -1) {
        pending = pending.subarray(start);
        break;
      }

      const frame = pending.subarray(start, end + 2);
      pending = pending.subarray(end + 2);

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(frame, { binary: true });
      }
    }
  });

  ffmpeg.on("exit", (code) => {
    console.log(`ffmpeg exited with code ${code ?? 0}`);
    socket.close();
  });
});

socket.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
