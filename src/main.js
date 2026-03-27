import "./style.css";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { VRButton } from "three/examples/jsm/webxr/VRButton.js";

const PROJECTION_WIDTH = 13414;
const PROJECTION_HEIGHT = 1080;
const PROJECTION_ASPECT = PROJECTION_WIDTH / PROJECTION_HEIGHT;
const BASE_SCREEN_HEIGHT = 4;
const BASE_RADIUS = (PROJECTION_ASPECT * BASE_SCREEN_HEIGHT) / (2 * Math.PI);
const CARDINAL_LABELS = ["N", "E", "S", "W"];

const canvas = document.querySelector("#scene");
const monitorCanvas = document.querySelector("#monitor");
const monitorContext = monitorCanvas.getContext("2d");
const videoElement = document.querySelector("#videoSource");
const hud = document.querySelector("#hud");
const toggleHudButton = document.querySelector("#toggleHud");
const fileInput = document.querySelector("#fileInput");
const fileField = document.querySelector("#fileField");
const protocolField = document.querySelector("#protocolField");
const protocolCustomField = document.querySelector("#protocolCustomField");
const protocolTargetInput = document.querySelector("#protocolTarget");
const protocolTargetSelect = document.querySelector("#protocolTargetSelect");
const protocolTargetMeta = document.querySelector("#protocolTargetMeta");
const refreshProtocolSourcesButton = document.querySelector("#refreshProtocolSources");
const activateSourceButton = document.querySelector("#activateSource");
const sourceModeSelect = document.querySelector("#sourceMode");
const sourceStatus = document.querySelector("#sourceStatus");
const diameterInput = document.querySelector("#diameterMeters");
const heightInput = document.querySelector("#heightMeters");
const coverageValue = document.querySelector("#coverageValue");

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.outputColorSpace = THREE.SRGBColorSpace;

const PREVIEW_WIDTH = Math.min(
  PROJECTION_WIDTH,
  renderer.capabilities.maxTextureSize,
  8192,
);
const PREVIEW_HEIGHT = Math.round(PREVIEW_WIDTH / PROJECTION_ASPECT);
const PREVIEW_LABEL = `${PREVIEW_WIDTH}x${PREVIEW_HEIGHT}`;
const MANAGED_SOURCE_MODES = new Set(["syphon", "ndi", "spout"]);
const PICKER_SOURCE_MODES = new Set(["syphon", "ndi"]);
const BRIDGE_PORT = 8787;
const CUSTOM_SOURCE_VALUE = "__custom__";

document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color("#03080d");

const camera = new THREE.PerspectiveCamera(
  68,
  window.innerWidth / window.innerHeight,
  0.01,
  200,
);
camera.position.set(0, 1.7, 0.01);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.7, -1);
controls.enablePan = false;
controls.rotateSpeed = -0.28;
controls.minDistance = 0.01;
controls.maxDistance = 0.01;
controls.update();

const ambient = new THREE.AmbientLight("#ffffff", 1.5);
scene.add(ambient);

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(BASE_RADIUS * 0.78, 96),
  new THREE.MeshBasicMaterial({
    color: "#071019",
    transparent: true,
    opacity: 0.85,
  }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0.001;
scene.add(ground);

const guideRing = new THREE.Mesh(
  new THREE.RingGeometry(BASE_RADIUS * 0.785, BASE_RADIUS * 0.8, 128),
  new THREE.MeshBasicMaterial({
    color: "#29516f",
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.55,
  }),
);
guideRing.rotation.x = -Math.PI / 2;
guideRing.position.y = 0.002;
scene.add(guideRing);

function createFloorLabel(text) {
  const labelCanvas = document.createElement("canvas");
  labelCanvas.width = 256;
  labelCanvas.height = 128;
  const labelContext = labelCanvas.getContext("2d");
  labelContext.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
  labelContext.fillStyle = "#d9d9d9";
  labelContext.font = "700 72px IBM Plex Mono, monospace";
  labelContext.textAlign = "center";
  labelContext.textBaseline = "middle";
  labelContext.fillText(text, labelCanvas.width / 2, labelCanvas.height / 2);

  const labelTexture = new THREE.CanvasTexture(labelCanvas);
  labelTexture.colorSpace = THREE.SRGBColorSpace;

  const labelMaterial = new THREE.MeshBasicMaterial({
    map: labelTexture,
    transparent: true,
    side: THREE.DoubleSide,
  });

  const labelMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1.3, 0.65),
    labelMaterial,
  );
  labelMesh.rotation.x = -Math.PI / 2;
  labelMesh.position.y = 0.01;
  return labelMesh;
}

const floorLabels = Object.fromEntries(
  CARDINAL_LABELS.map((label) => [label, createFloorLabel(label)]),
);

Object.values(floorLabels).forEach((labelMesh) => {
  scene.add(labelMesh);
});

const axisLineMaterial = new THREE.LineBasicMaterial({
  color: "#4a4a4a",
  transparent: true,
  opacity: 0.9,
});

const seamLineMaterial = new THREE.LineBasicMaterial({
  color: "#b8d8ff",
  transparent: true,
  opacity: 0.95,
});

function createFloorLine(material) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0.008, 0, 0, 0.008, 0], 3),
  );
  const line = new THREE.Line(geometry, material);
  scene.add(line);
  return line;
}

const northSouthAxis = createFloorLine(axisLineMaterial);
const eastWestAxis = createFloorLine(axisLineMaterial);
const seamMarker = createFloorLine(seamLineMaterial);

const textureCanvas = document.createElement("canvas");
textureCanvas.width = PREVIEW_WIDTH;
textureCanvas.height = PREVIEW_HEIGHT;
const textureContext = textureCanvas.getContext("2d");

const projectionTexture = new THREE.CanvasTexture(textureCanvas);
projectionTexture.colorSpace = THREE.SRGBColorSpace;
projectionTexture.minFilter = THREE.LinearFilter;
projectionTexture.magFilter = THREE.LinearFilter;
projectionTexture.repeat.x = -1;
projectionTexture.offset.x = 1;

const cylinderMaterial = new THREE.MeshBasicMaterial({
  map: projectionTexture,
  side: THREE.BackSide,
});

let cylinderMesh = null;
let activeStream = null;
let bridgeSocket = null;
let bridgeImageBitmap = null;
let isHudOpen = true;
let cylinderDiameterMeters = Number(diameterInput.value) || BASE_RADIUS * 2;
let cylinderHeightMeters = Number(heightInput.value) || BASE_SCREEN_HEIGHT;
let sourceState = {
  mode: "demo",
  info: `Demo test pattern is active. Preview texture ${PREVIEW_LABEL}.`,
};
let managedSourceItemsByMode = {
  syphon: [],
  ndi: [],
};

function setStatus(message) {
  sourceStatus.textContent = message;
}

function isManagedSourceMode(mode) {
  return MANAGED_SOURCE_MODES.has(mode);
}

function supportsSourcePicker(mode) {
  return PICKER_SOURCE_MODES.has(mode);
}

function getManagedSourceItem(mode, target) {
  const items = managedSourceItemsByMode[mode] || [];
  return items.find((item) => item.target === target) || null;
}

function formatManagedSourceMeta(mode, item) {
  if (!supportsSourcePicker(mode)) {
    return "Enter a source name manually for this protocol.";
  }

  if (protocolTargetSelect.value === CUSTOM_SOURCE_VALUE) {
    return "Custom source name override.";
  }

  if (!item) {
    return "Automatic source selection.";
  }

  const ownerFieldLabel = mode === "ndi" ? "Host" : "App";
  const ownerLabel = item.appName ? `${ownerFieldLabel}: ${item.appName}` : null;
  const sourceLabel = item.sourceName ? `Source: ${item.sourceName}` : null;
  const statusLabel = `Status: ${item.isLive ? "live" : "unknown"}`;
  return [ownerLabel, sourceLabel, statusLabel].filter(Boolean).join(" | ");
}

function getBridgeHost() {
  return window.location.hostname || "localhost";
}

function getBridgeFrameUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${getBridgeHost()}:${BRIDGE_PORT}/frames`;
}

function getBridgeControlBaseUrl() {
  const protocol = window.location.protocol === "https:" ? "https:" : "http:";
  return `${protocol}//${getBridgeHost()}:${BRIDGE_PORT}`;
}

async function stopManagedSource() {
  try {
    await fetch(`${getBridgeControlBaseUrl()}/control/stop`, {
      method: "POST",
    });
  } catch {
    // Ignore bridge control errors when switching away from managed sources.
  }
}

async function fetchManagedSourceItems(mode, { preserveSelection = true } = {}) {
  if (!supportsSourcePicker(mode)) {
    return;
  }

  const previousValue = preserveSelection ? protocolTargetSelect.value : "";
  const response = await fetch(`${getBridgeControlBaseUrl()}/sources/${mode}/items`);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || `Could not list ${mode.toUpperCase()} sources.`);
  }

  managedSourceItemsByMode = {
    ...managedSourceItemsByMode,
    [mode]: Array.isArray(payload.items) ? payload.items : [],
  };
  renderProtocolTargetOptions(mode, previousValue);
  syncProtocolCustomField();
}

function setHudOpen(nextState) {
  isHudOpen = nextState;
  hud.classList.toggle("hud--collapsed", !isHudOpen);
  toggleHudButton.textContent = isHudOpen ? "Hide Controls" : "Show Controls";
  toggleHudButton.setAttribute("aria-expanded", String(isHudOpen));
}

function renderProtocolTargetOptions(mode, preferredValue = protocolTargetSelect.value) {
  const items = managedSourceItemsByMode[mode] || [];
  const options = [
    {
      value: "",
      label: "Automatic (first available)",
    },
    ...items.map((item) => ({
      value: item.target,
      label: item.label,
    })),
  ];

  if (supportsSourcePicker(mode)) {
    options.push({
      value: CUSTOM_SOURCE_VALUE,
      label: "Custom...",
    });
  }

  protocolTargetSelect.replaceChildren(
    ...options.map((option) => {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      return element;
    }),
  );

  const hasPreferredValue = options.some((option) => option.value === preferredValue);
  protocolTargetSelect.value = hasPreferredValue ? preferredValue : "";
  updateProtocolMeta();
}

function syncProtocolCustomField() {
  const mode = sourceModeSelect.value;
  const shouldShowCustomField =
    isManagedSourceMode(mode) &&
    (!supportsSourcePicker(mode) || protocolTargetSelect.value === CUSTOM_SOURCE_VALUE);
  protocolCustomField.classList.toggle("is-hidden", !shouldShowCustomField);
  updateProtocolMeta();
}

function updateProtocolMeta() {
  const mode = sourceModeSelect.value;
  const item = getManagedSourceItem(mode, protocolTargetSelect.value);
  protocolTargetMeta.textContent = formatManagedSourceMeta(mode, item);
}

function syncSourceFields() {
  const mode = sourceModeSelect.value;
  const isManagedMode = isManagedSourceMode(mode);
  const usesSourcePicker = supportsSourcePicker(mode);
  fileField.classList.toggle("is-hidden", mode !== "file");
  protocolField.classList.toggle("is-hidden", !isManagedMode);
  refreshProtocolSourcesButton.classList.toggle("is-hidden", !usesSourcePicker);
  protocolTargetSelect.disabled = !usesSourcePicker;
  if (!usesSourcePicker) {
    renderProtocolTargetOptions(mode);
  }
  syncProtocolCustomField();
}

function getSelectedManagedTarget() {
  if (!supportsSourcePicker(sourceModeSelect.value)) {
    return protocolTargetInput.value.trim();
  }

  if (protocolTargetSelect.value === CUSTOM_SOURCE_VALUE) {
    return protocolTargetInput.value.trim();
  }

  return protocolTargetSelect.value.trim();
}

function formatCoverage(value) {
  if (value > 360) {
    return `${value.toFixed(1)}° -> 360° max`;
  }

  if (value < 1) {
    return `${value.toFixed(1)}° -> 1° min`;
  }

  return `${value.toFixed(1)}°`;
}

function parsePositiveNumber(value) {
  if (value.trim() === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
}

function updateCoverageLabel(diameterMeters, heightMeters) {
  const derivedCoverageDegrees =
    (PROJECTION_ASPECT * heightMeters * 360) / (Math.PI * diameterMeters);
  coverageValue.textContent = formatCoverage(derivedCoverageDegrees);
  return derivedCoverageDegrees;
}

function rebuildCylinder({ normalizeInputs = false } = {}) {
  const diameterMeters = Math.max(cylinderDiameterMeters, 0.1);
  const heightMeters = Math.max(cylinderHeightMeters, 0.1);
  const radius = diameterMeters / 2;
  const derivedCoverageDegrees = updateCoverageLabel(diameterMeters, heightMeters);
  const coverageDegrees = THREE.MathUtils.clamp(derivedCoverageDegrees, 1, 360);

  if (normalizeInputs) {
    diameterInput.value = diameterMeters.toFixed(2);
    heightInput.value = heightMeters.toFixed(2);
  }

  if (cylinderMesh) {
    scene.remove(cylinderMesh);
    cylinderMesh.geometry.dispose();
  }

  const thetaLength = THREE.MathUtils.degToRad(coverageDegrees);
  const thetaStart = Math.PI / 2 - thetaLength / 2;
  const geometry = new THREE.CylinderGeometry(
    radius,
    radius,
    heightMeters,
    160,
    1,
    true,
    thetaStart,
    thetaLength,
  );
  cylinderMesh = new THREE.Mesh(geometry, cylinderMaterial);
  cylinderMesh.position.y = heightMeters / 2;
  cylinderMesh.rotation.y = Math.PI / 2;
  scene.add(cylinderMesh);

  ground.scale.setScalar(radius / BASE_RADIUS);
  guideRing.scale.setScalar(radius / BASE_RADIUS);

  const labelRadius = radius * 0.62;
  const labelScale = Math.max(0.75, radius * 0.055);

  floorLabels.N.position.set(0, 0.01, -labelRadius);
  floorLabels.E.position.set(labelRadius, 0.01, 0);
  floorLabels.S.position.set(0, 0.01, labelRadius);
  floorLabels.W.position.set(-labelRadius, 0.01, 0);

  Object.values(floorLabels).forEach((labelMesh) => {
    labelMesh.scale.setScalar(labelScale);
  });

  northSouthAxis.geometry.setFromPoints([
    new THREE.Vector3(0, 0.008, -radius * 0.74),
    new THREE.Vector3(0, 0.008, radius * 0.74),
  ]);
  eastWestAxis.geometry.setFromPoints([
    new THREE.Vector3(-radius * 0.74, 0.008, 0),
    new THREE.Vector3(radius * 0.74, 0.008, 0),
  ]);
  seamMarker.geometry.setFromPoints([
    new THREE.Vector3(-radius * 0.14, 0.008, radius * 0.74),
    new THREE.Vector3(radius * 0.14, 0.008, radius * 0.74),
  ]);
}

function syncCylinderInputs({ normalize = false } = {}) {
  const parsedDiameter = parsePositiveNumber(diameterInput.value);
  const parsedHeight = parsePositiveNumber(heightInput.value);

  if (parsedDiameter !== null) {
    cylinderDiameterMeters = parsedDiameter;
  }

  if (parsedHeight !== null) {
    cylinderHeightMeters = parsedHeight;
  }

  rebuildCylinder({ normalizeInputs: normalize });
}

function stopActiveStream() {
  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }
}

function disconnectBridge() {
  if (bridgeSocket) {
    bridgeSocket.close();
    bridgeSocket = null;
  }
}

function resetVideoElement() {
  videoElement.pause();
  videoElement.removeAttribute("src");
  videoElement.srcObject = null;
  videoElement.load();
}

async function activateFileSource() {
  void stopManagedSource();
  stopActiveStream();
  disconnectBridge();

  const file = fileInput.files?.[0];
  if (!file) {
    setStatus("Choose a video file first.");
    return;
  }

  resetVideoElement();
  const objectUrl = URL.createObjectURL(file);
  videoElement.src = objectUrl;
  videoElement.loop = true;
  videoElement.muted = true;
  await videoElement.play();

  sourceState = {
    mode: "video",
    info: `Playing file: ${file.name} at preview texture ${PREVIEW_LABEL}.`,
  };
  setStatus(sourceState.info);
}

async function activateScreenSource() {
  void stopManagedSource();
  stopActiveStream();
  disconnectBridge();
  resetVideoElement();

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      cursor: "always",
    },
    audio: false,
  });

  activeStream = stream;
  videoElement.srcObject = stream;
  videoElement.muted = true;
  await videoElement.play();

  sourceState = {
    mode: "video",
    info: `Screen capture is active at preview texture ${PREVIEW_LABEL}.`,
  };
  setStatus(sourceState.info);
}

async function activateCameraSource() {
  void stopManagedSource();
  stopActiveStream();
  disconnectBridge();
  resetVideoElement();

  const stream = await navigator.mediaDevices.getUserMedia({
    video: true,
    audio: false,
  });

  activeStream = stream;
  videoElement.srcObject = stream;
  videoElement.muted = true;
  await videoElement.play();

  sourceState = {
    mode: "video",
    info: `Camera stream is active at preview texture ${PREVIEW_LABEL}.`,
  };
  setStatus(sourceState.info);
}

function activateDemoSource() {
  void stopManagedSource();
  stopActiveStream();
  disconnectBridge();
  resetVideoElement();
  sourceState = {
    mode: "demo",
    info: `Demo test pattern is active. Preview texture ${PREVIEW_LABEL}.`,
  };
  setStatus(sourceState.info);
}

function handleBridgeFrame(data) {
  const blob = new Blob([data], { type: "image/jpeg" });
  createImageBitmap(blob).then((bitmap) => {
    if (bridgeImageBitmap) {
      bridgeImageBitmap.close();
    }
    bridgeImageBitmap = bitmap;
  });
}

function activateBridgeSource() {
  stopActiveStream();
  resetVideoElement();
  disconnectBridge();

  bridgeSocket = new WebSocket(getBridgeFrameUrl());
  bridgeSocket.binaryType = "arraybuffer";

  bridgeSocket.addEventListener("open", () => {
    sourceState = {
      mode: "bridge",
      info: `Connected to frame bridge. Preview texture ${PREVIEW_LABEL}.`,
    };
    setStatus(sourceState.info);
  });

  bridgeSocket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "meta" && payload.label) {
          setStatus(`Bridge source: ${payload.label}`);
        }
      } catch {
        setStatus("Bridge is sending text messages.");
      }
      return;
    }

    handleBridgeFrame(event.data);
  });

  bridgeSocket.addEventListener("close", () => {
    if (sourceState.mode === "bridge") {
      setStatus("Bridge disconnected.");
    }
  });

  bridgeSocket.addEventListener("error", () => {
    setStatus("Could not connect to the bridge.");
  });
}

async function activateManagedSource(mode) {
  stopActiveStream();
  resetVideoElement();
  disconnectBridge();

  const protocolName = mode.toUpperCase();
  setStatus(`Launching ${protocolName} source...`);

  const response = await fetch(`${getBridgeControlBaseUrl()}/control/launch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: mode,
      target: getSelectedManagedTarget(),
    }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Could not launch ${protocolName}.`);
  }

  activateBridgeSource();
}

async function activateSelectedSource() {
  try {
    const mode = sourceModeSelect.value;
    if (mode === "demo") {
      activateDemoSource();
      return;
    }
    if (mode === "file") {
      await activateFileSource();
      return;
    }
    if (mode === "screen") {
      await activateScreenSource();
      return;
    }
    if (mode === "camera") {
      await activateCameraSource();
      return;
    }
    if (mode === "bridge") {
      activateBridgeSource();
      return;
    }
    if (isManagedSourceMode(mode)) {
      await activateManagedSource(mode);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Source activation failed.";
    setStatus(message);
  }
}

async function refreshManagedSourcesForCurrentMode({ preserveSelection = true } = {}) {
  const mode = sourceModeSelect.value;
  if (!supportsSourcePicker(mode)) {
    return;
  }

  try {
    setStatus(`Refreshing ${mode.toUpperCase()} sources...`);
    await fetchManagedSourceItems(mode, { preserveSelection });
    const items = managedSourceItemsByMode[mode] || [];
    setStatus(
      items.length > 0
        ? `${mode.toUpperCase()} sources ready: ${items.length} found.`
        : `${mode.toUpperCase()} sources ready: none found yet.`,
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : `Could not refresh ${mode.toUpperCase()} sources.`;
    setStatus(message);
    renderProtocolTargetOptions(mode, CUSTOM_SOURCE_VALUE);
    protocolTargetSelect.value = CUSTOM_SOURCE_VALUE;
    syncProtocolCustomField();
  }
}

function drawDemo(now) {
  const time = now * 0.001;
  textureContext.fillStyle = "#050607";
  textureContext.fillRect(0, 0, textureCanvas.width, textureCanvas.height);

  const stripeCount = 18;
  for (let index = 0; index < stripeCount; index += 1) {
    const width = textureCanvas.width / stripeCount;
    const x = index * width;
    const hue = 14 + (index / stripeCount) * 190;
    textureContext.fillStyle = `hsl(${hue}, 88%, ${45 + Math.sin(time + index * 0.35) * 12}%)`;
    textureContext.fillRect(x, 0, width + 2, textureCanvas.height);
  }

  textureContext.fillStyle = "rgba(4, 10, 15, 0.65)";
  textureContext.fillRect(0, textureCanvas.height * 0.62, textureCanvas.width, textureCanvas.height * 0.38);

  textureContext.strokeStyle = "rgba(255,255,255,0.16)";
  textureContext.lineWidth = 6;
  const horizonY = textureCanvas.height * 0.53;
  textureContext.beginPath();
  for (let x = 0; x <= textureCanvas.width; x += 32) {
    const y = horizonY + Math.sin((x / textureCanvas.width) * Math.PI * 8 + time) * 36;
    if (x === 0) {
      textureContext.moveTo(x, y);
    } else {
      textureContext.lineTo(x, y);
    }
  }
  textureContext.stroke();

  textureContext.fillStyle = "#f7f1dd";
  textureContext.font = "bold 220px Avenir Next, sans-serif";
  textureContext.fillText("The Adventures of Prince Achmed", 320, 260);
  textureContext.font = "600 92px Avenir Next, sans-serif";
  textureContext.fillStyle = "rgba(255,255,255,0.9)";
  textureContext.fillText("Wintercircus cylindrical preview", 320, 390);
  textureContext.fillText("13414 × 1080", 320, 500);
  textureContext.fillText(`Preview texture ${PREVIEW_LABEL}`, 320, 610);
  textureContext.fillText(`Time ${time.toFixed(2)}s`, 320, 720);
}

function drawVideoSource() {
  if (videoElement.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return;
  }

  textureContext.drawImage(videoElement, 0, 0, textureCanvas.width, textureCanvas.height);
}

function drawBridgeSource() {
  if (!bridgeImageBitmap) {
    return;
  }

  textureContext.drawImage(bridgeImageBitmap, 0, 0, textureCanvas.width, textureCanvas.height);
}

function drawMonitor() {
  monitorContext.drawImage(textureCanvas, 0, 0, monitorCanvas.width, monitorCanvas.height);
}

function renderFrame(now) {
  if (sourceState.mode === "demo") {
    drawDemo(now);
  } else if (sourceState.mode === "video") {
    drawVideoSource();
  } else if (sourceState.mode === "bridge") {
    drawBridgeSource();
  }

  drawMonitor();
  projectionTexture.needsUpdate = true;
  renderer.render(scene, camera);
}

activateSourceButton.addEventListener("click", activateSelectedSource);
toggleHudButton.addEventListener("click", () => {
  setHudOpen(!isHudOpen);
});
sourceModeSelect.addEventListener("change", () => {
  syncSourceFields();
  void refreshManagedSourcesForCurrentMode();
});
protocolTargetSelect.addEventListener("change", () => {
  syncProtocolCustomField();
});
refreshProtocolSourcesButton.addEventListener("click", () => {
  void refreshManagedSourcesForCurrentMode();
});
diameterInput.addEventListener("input", () => {
  syncCylinderInputs();
});
heightInput.addEventListener("input", () => {
  syncCylinderInputs();
});
diameterInput.addEventListener("change", () => {
  syncCylinderInputs({ normalize: true });
});
heightInput.addEventListener("change", () => {
  syncCylinderInputs({ normalize: true });
});
diameterInput.addEventListener("blur", () => {
  syncCylinderInputs({ normalize: true });
});
heightInput.addEventListener("blur", () => {
  syncCylinderInputs({ normalize: true });
});
window.addEventListener("keydown", (event) => {
  const target = event.target;
  const isTypingTarget =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement;

  if (
    event.key.toLowerCase() === "h" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !isTypingTarget
  ) {
    setHudOpen(!isHudOpen);
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

syncCylinderInputs({ normalize: true });
syncSourceFields();
renderProtocolTargetOptions(sourceModeSelect.value);
setHudOpen(true);
activateDemoSource();
renderer.setAnimationLoop(renderFrame);
