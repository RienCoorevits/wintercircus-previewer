import http from "node:http";
import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";
import {
  listManagedSources,
  resolveManagedLaunch,
  resolveManagedSourceList,
} from "./managed-sources.mjs";

const PORT = Number(process.env.BRIDGE_PORT || 8787);
const viewers = new Set();
let activeSender = null;
let sourceMeta = {
  type: "meta",
  label: "No sender attached.",
};
let managedSource = {
  protocol: null,
  target: null,
  status: "idle",
  pid: null,
  lastError: null,
  lastExitCode: null,
  log: [],
};
let managedProcess = null;

function listManagedSourceItems(protocol) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const spec = resolveManagedSourceList(protocol);
    const child = spawn(spec.command, spec.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    const finish = (handler) => (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      handler(value);
    };

    const resolveOnce = finish(resolve);
    const rejectOnce = finish(reject);

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectOnce(new Error(`${spec.descriptor.label} source listing timed out.`));
    }, 30000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      rejectOnce(error);
    });

    child.on("exit", (code) => {
      if (code !== 0) {
        rejectOnce(
          new Error(
            stderr.trim() || `${spec.descriptor.label} source listing exited with code ${code ?? "null"}.`,
          ),
        );
        return;
      }

      try {
        const payload = JSON.parse(stdout.trim() || "{\"items\":[]}");
        resolveOnce(Array.isArray(payload.items) ? payload.items : []);
      } catch (error) {
        rejectOnce(
          new Error(
            `Could not parse ${spec.descriptor.label} source list.${stderr ? ` ${stderr.trim()}` : ""}`,
          ),
        );
      }
    });
  });
}

function pushManagedLog(line) {
  managedSource.log.push(line);
  if (managedSource.log.length > 12) {
    managedSource.log = managedSource.log.slice(-12);
  }
}

function setCorsHeaders(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type");
}

function sendJson(response, statusCode, payload) {
  setCorsHeaders(response);
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => {
      chunks.push(chunk);
    });

    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });

    request.on("error", reject);
  });
}

function stopManagedSource() {
  if (!managedProcess) {
    managedSource = {
      ...managedSource,
      protocol: null,
      target: null,
      status: "idle",
      pid: null,
    };
    return false;
  }

  managedProcess.kill("SIGTERM");
  managedProcess = null;
  managedSource = {
    ...managedSource,
    status: "stopping",
    pid: null,
  };
  return true;
}

function launchManagedSource(protocol, target) {
  stopManagedSource();

  const ingestUrl = `ws://localhost:${PORT}/ingest`;
  const spec = resolveManagedLaunch(protocol, {
    ingestUrl,
    target,
  });

  const child = spawn(spec.command, spec.args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
  managedProcess = child;
  managedSource = {
    protocol,
    target: target || "",
    status: "starting",
    pid: child.pid,
    lastError: null,
    lastExitCode: null,
    log: [],
  };
  sourceMeta = {
    type: "meta",
    label: `Launching ${spec.descriptor.label}${target ? `: ${target}` : ""}`,
  };
  broadcastJson(sourceMeta);

  const handleOutput = (chunk) => {
    const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      pushManagedLog(line);
    }
  };

  child.stdout.on("data", handleOutput);
  child.stderr.on("data", handleOutput);

  child.on("spawn", () => {
    managedSource = {
      ...managedSource,
      status: "running",
    };
  });

  child.on("error", (error) => {
    managedSource = {
      ...managedSource,
      status: "failed",
      pid: null,
      lastError: error.message,
    };
    managedProcess = null;
  });

  child.on("exit", (code, signal) => {
    managedSource = {
      ...managedSource,
      status: code === 0 ? "stopped" : "failed",
      pid: null,
      lastExitCode: code,
      lastError:
        code === 0
          ? null
          : `Adapter exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}.`,
    };
    managedProcess = null;
    if (!activeSender) {
      sourceMeta = {
        type: "meta",
        label:
          managedSource.lastError ||
          `${protocol} adapter stopped.`,
      };
      broadcastJson(sourceMeta);
    }
  });

  return {
    protocol,
    target: target || "",
    status: managedSource.status,
  };
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (request.method === "OPTIONS") {
    setCorsHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      viewers: viewers.size,
      hasSender: Boolean(activeSender),
      managedSource,
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/sources") {
    sendJson(response, 200, {
      items: listManagedSources(),
      managedSource,
    });
    return;
  }

  const sourceItemsMatch = url.pathname.match(/^\/sources\/([^/]+)\/items$/);
  if (request.method === "GET" && sourceItemsMatch) {
    const protocol = sourceItemsMatch[1];

    listManagedSourceItems(protocol)
      .then((items) => {
        sendJson(response, 200, {
          protocol,
          items,
        });
      })
      .catch((error) => {
        sendJson(response, 400, {
          error: error instanceof Error ? error.message : "Could not list sources.",
        });
      });
    return;
  }

  if (request.method === "POST" && url.pathname === "/control/launch") {
    readJsonBody(request)
      .then((body) => {
        const protocol = typeof body.protocol === "string" ? body.protocol.trim() : "";
        const target = typeof body.target === "string" ? body.target.trim() : "";

        if (!protocol) {
          sendJson(response, 400, { error: "Missing protocol." });
          return;
        }

        try {
          const state = launchManagedSource(protocol, target);
          sendJson(response, 200, { ok: true, state });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Launch failed.";
          sendJson(response, 400, { error: message });
        }
      })
      .catch((error) => {
        sendJson(response, 400, { error: `Invalid JSON body: ${error.message}` });
      });
    return;
  }

  if (request.method === "POST" && url.pathname === "/control/stop") {
    const stopped = stopManagedSource();
    sendJson(response, 200, {
      ok: true,
      stopped,
      managedSource,
    });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
});

const viewerServer = new WebSocketServer({ noServer: true });
const senderServer = new WebSocketServer({ noServer: true });

function broadcastJson(payload) {
  const message = JSON.stringify(payload);
  for (const viewer of viewers) {
    if (viewer.readyState === viewer.OPEN) {
      viewer.send(message);
    }
  }
}

function broadcastBinary(payload) {
  for (const viewer of viewers) {
    if (viewer.readyState === viewer.OPEN) {
      viewer.send(payload, { binary: true });
    }
  }
}

viewerServer.on("connection", (socket) => {
  viewers.add(socket);
  socket.send(JSON.stringify(sourceMeta));

  socket.on("close", () => {
    viewers.delete(socket);
  });
});

senderServer.on("connection", (socket) => {
  if (activeSender) {
    activeSender.close(1013, "Another sender connected.");
  }

  activeSender = socket;
  sourceMeta = {
    type: "meta",
    label: "Sender connected.",
  };
  broadcastJson(sourceMeta);

  socket.on("message", (message, isBinary) => {
    if (isBinary) {
      broadcastBinary(message);
      return;
    }

    try {
      const payload = JSON.parse(message.toString());
      if (payload.type === "meta") {
        sourceMeta = payload;
        broadcastJson(sourceMeta);
      }
    } catch {
      sourceMeta = {
        type: "meta",
        label: "Sender is online.",
      };
      broadcastJson(sourceMeta);
    }
  });

  socket.on("close", () => {
    if (activeSender === socket) {
      activeSender = null;
      sourceMeta = {
        type: "meta",
        label: "Sender disconnected.",
      };
      broadcastJson(sourceMeta);
    }
  });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  if (url.pathname === "/frames") {
    viewerServer.handleUpgrade(request, socket, head, (websocket) => {
      viewerServer.emit("connection", websocket, request);
    });
    return;
  }

  if (url.pathname === "/ingest") {
    senderServer.handleUpgrade(request, socket, head, (websocket) => {
      senderServer.emit("connection", websocket, request);
    });
    return;
  }

  socket.destroy();
});

server.listen(PORT, () => {
  console.log(`Frame bridge listening on http://localhost:${PORT}`);
  console.log(`Viewer socket: ws://localhost:${PORT}/frames`);
  console.log(`Ingest socket: ws://localhost:${PORT}/ingest`);
});
