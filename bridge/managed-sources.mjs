import path from "node:path";
import process from "node:process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const NDI_SDK_DIR = process.env.NDI_SDK_DIR || "/Library/NDI SDK for Apple";
const NDI_HEADER_PATH = path.join(NDI_SDK_DIR, "include", "Processing.NDI.Lib.h");
const NDI_LIBRARY_PATH = path.join(NDI_SDK_DIR, "lib", "macOS", "libndi.dylib");

function protocolBase(protocol) {
  return {
    protocol,
    readmePath: path.join(ROOT_DIR, "native", protocol, "README.md"),
  };
}

export function listManagedSources() {
  const isMac = process.platform === "darwin";
  const isWindows = process.platform === "win32";
  const hasNdiSdk = fs.existsSync(NDI_HEADER_PATH) && fs.existsSync(NDI_LIBRARY_PATH);

  return [
    {
      ...protocolBase("syphon"),
      label: "Syphon",
      supported: isMac,
      reason: isMac ? null : "Syphon capture is only supported on macOS.",
    },
    {
      ...protocolBase("ndi"),
      label: "NDI",
      supported: isMac && hasNdiSdk,
      reason: !isMac
        ? "NDI capture is currently implemented for macOS."
        : hasNdiSdk
          ? null
          : `Install the Apple NDI SDK in ${NDI_SDK_DIR}.`,
    },
    {
      ...protocolBase("spout"),
      label: "Spout",
      supported: isWindows,
      reason: isWindows ? null : "Spout capture is only supported on Windows.",
    },
  ];
}

export function resolveManagedLaunch(protocol, { ingestUrl, target }) {
  const descriptor = listManagedSources().find((source) => source.protocol === protocol);

  if (!descriptor) {
    throw new Error(`Unknown managed source protocol: ${protocol}`);
  }

  if (!descriptor.supported) {
    throw new Error(descriptor.reason || `${descriptor.label} is not available here.`);
  }

  const args = [];
  if (target) {
    args.push("--source", target);
  }

  if (protocol === "syphon") {
    return {
      descriptor,
      command: "zsh",
      args: [
        path.join(ROOT_DIR, "native", "syphon", "run-adapter.sh"),
        "--ws",
        ingestUrl,
        ...args,
      ],
    };
  }

  if (protocol === "ndi") {
    return {
      descriptor,
      command: "zsh",
      args: [
        path.join(ROOT_DIR, "native", "ndi", "run-adapter.sh"),
        "--ws",
        ingestUrl,
        ...args,
      ],
    };
  }

  if (protocol === "spout") {
    return {
      descriptor,
      command: "pwsh",
      args: [
        "-File",
        path.join(ROOT_DIR, "native", "spout", "SpoutAdapter.ps1"),
        "-WsUrl",
        ingestUrl,
        ...(target ? ["-Source", target] : []),
      ],
    };
  }

  throw new Error(`No launch strategy defined for ${protocol}.`);
}

export function resolveManagedSourceList(protocol) {
  const descriptor = listManagedSources().find((source) => source.protocol === protocol);

  if (!descriptor) {
    throw new Error(`Unknown managed source protocol: ${protocol}`);
  }

  if (!descriptor.supported) {
    throw new Error(descriptor.reason || `${descriptor.label} is not available here.`);
  }

  if (protocol === "syphon") {
    return {
      descriptor,
      command: "zsh",
      args: [
        path.join(ROOT_DIR, "native", "syphon", "run-adapter.sh"),
        "--list-sources",
      ],
    };
  }

  if (protocol === "ndi") {
    return {
      descriptor,
      command: "zsh",
      args: [
        path.join(ROOT_DIR, "native", "ndi", "run-adapter.sh"),
        "--list-sources",
      ],
    };
  }

  throw new Error(`Source listing is not available for ${descriptor.label}.`);
}
