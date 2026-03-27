import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { ensureDevCertificate } from "./dev-cert.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST_DIR = path.join(ROOT_DIR, "dist");
const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 8787);
const QUEST_PORT = Number(process.env.QUEST_PORT || 5173);
const BRIDGE_TARGET_HOST = "127.0.0.1";
const BRIDGE_TARGET_ORIGIN = `http://${BRIDGE_TARGET_HOST}:${BRIDGE_PORT}`;

const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
]);

function getLanIpAddress() {
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) {
        return entry.address;
      }
    }
  }

  return null;
}

function getContentType(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || "application/octet-stream";
}

function sanitizeAssetPath(requestPath) {
  const decodedPath = decodeURIComponent(requestPath);
  const trimmedPath = decodedPath.replace(/^\/+/, "");
  const normalizedPath = path.normalize(trimmedPath);

  if (
    normalizedPath.startsWith("..") ||
    path.isAbsolute(normalizedPath) ||
    normalizedPath.includes(`..${path.sep}`)
  ) {
    return null;
  }

  return normalizedPath;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => {
      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(chunks.length > 0 ? Buffer.concat(chunks) : null);
    });

    request.on("error", reject);
  });
}

async function proxyBridgeRequest(request, response, requestUrl) {
  const bridgePath = requestUrl.pathname.replace(/^\/bridge/, "") || "/";
  const bridgeUrl = new URL(bridgePath + requestUrl.search, BRIDGE_TARGET_ORIGIN);
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : await readRequestBody(request);

  const proxyResponse = await fetch(bridgeUrl, {
    method: request.method,
    headers: Object.fromEntries(
      Object.entries(request.headers).filter(([name]) =>
        !["connection", "content-length", "host", "transfer-encoding"].includes(
          name.toLowerCase(),
        ),
      ),
    ),
    body,
  });

  response.writeHead(proxyResponse.status, Object.fromEntries(proxyResponse.headers.entries()));
  const responseBuffer = Buffer.from(await proxyResponse.arrayBuffer());
  response.end(responseBuffer);
}

function serveStaticFile(response, requestPath) {
  const assetPath = sanitizeAssetPath(requestPath);
  if (assetPath === null) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  const resolvedPath = assetPath === "" ? "index.html" : assetPath;
  const targetFile = path.join(DIST_DIR, resolvedPath);
  const fallbackFile = path.join(DIST_DIR, "index.html");
  const filePath =
    fs.existsSync(targetFile) && fs.statSync(targetFile).isFile() ? targetFile : fallbackFile;

  response.writeHead(200, {
    "content-type": getContentType(filePath),
  });
  fs.createReadStream(filePath).pipe(response);
}

const { certFile, keyFile, lanIpAddress } = ensureDevCertificate();

console.log("Building Quest bundle...");
execFileSync("npm", ["run", "build"], {
  cwd: ROOT_DIR,
  stdio: "inherit",
});

const httpsServer = https.createServer(
  {
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile),
  },
  async (request, response) => {
    const requestUrl = new URL(request.url || "/", `https://${request.headers.host || "localhost"}`);

    try {
      if (requestUrl.pathname.startsWith("/bridge")) {
        await proxyBridgeRequest(request, response, requestUrl);
        return;
      }

      serveStaticFile(response, requestUrl.pathname);
    } catch (error) {
      response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "Proxy error");
    }
  },
);

const proxyWebSocketServer = new WebSocketServer({ noServer: true });

proxyWebSocketServer.on("connection", (clientSocket, request) => {
  const requestUrl = new URL(request.url || "/", `https://${request.headers.host || "localhost"}`);
  const upstreamUrl = new URL(
    requestUrl.pathname.replace(/^\/bridge/, "") + requestUrl.search,
    `ws://${BRIDGE_TARGET_HOST}:${BRIDGE_PORT}`,
  );

  const upstreamSocket = new WebSocket(upstreamUrl, {
    headers: {
      origin: BRIDGE_TARGET_ORIGIN,
    },
  });

  const closeCode = (value) =>
    Number.isInteger(value) && value >= 1000 && value <= 4999 && value !== 1005 && value !== 1006
      ? value
      : 1000;

  const closeReason = (value) =>
    typeof value === "string" ? value : "";

  const closeBoth = (code, reason) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.close(closeCode(code), closeReason(reason));
    }
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.close(closeCode(code), closeReason(reason));
    }
  };

  clientSocket.on("message", (data, isBinary) => {
    if (upstreamSocket.readyState === WebSocket.OPEN) {
      upstreamSocket.send(data, { binary: isBinary });
    }
  });

  upstreamSocket.on("message", (data, isBinary) => {
    if (clientSocket.readyState === WebSocket.OPEN) {
      clientSocket.send(data, { binary: isBinary });
    }
  });

  clientSocket.on("close", (code, reason) => {
    closeBoth(code, reason);
  });

  upstreamSocket.on("close", (code, reason) => {
    closeBoth(code, reason);
  });

  clientSocket.on("error", () => {
    closeBoth(1011, "client websocket error");
  });

  upstreamSocket.on("error", () => {
    closeBoth(1011, "bridge websocket error");
  });
});

httpsServer.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(request.url || "/", `https://${request.headers.host || "localhost"}`);

  if (!requestUrl.pathname.startsWith("/bridge/")) {
    socket.destroy();
    return;
  }

  proxyWebSocketServer.handleUpgrade(request, socket, head, (websocket) => {
    proxyWebSocketServer.emit("connection", websocket, request);
  });
});

httpsServer.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

httpsServer.listen(QUEST_PORT, "0.0.0.0", () => {
  console.log(`Quest HTTPS certificate ready: ${certFile}`);
  console.log(`Bridge proxy target: ${BRIDGE_TARGET_ORIGIN}`);
  console.log(`Local URL: https://localhost:${QUEST_PORT}`);
  if (lanIpAddress) {
    console.log(`Mac IP: ${lanIpAddress}:${QUEST_PORT}`);
    console.log(`Quest URL: https://${lanIpAddress}:${QUEST_PORT}`);
  } else {
    console.log(`Quest URL: LAN IP not detected automatically on ${os.hostname()}.`);
  }
  console.log("Quest Browser will likely show a self-signed certificate warning on first open.");
});
