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
const SILHOUETTE_HEIGHTS = [1.6, 1.65, 1.7, 1.75, 1.8];

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
const eyeHeightInput = document.querySelector("#eyeHeightMeters");
const silhouetteCountInput = document.querySelector("#silhouetteCount");
const ambientLightIntensityInput = document.querySelector("#ambientLightIntensity");
const floorSpillIntensityInput = document.querySelector("#floorSpillIntensity");
const floorSpillBlurInput = document.querySelector("#floorSpillBlur");
const floorSpillFalloffInput = document.querySelector("#floorSpillFalloff");
const floorBaseLevelInput = document.querySelector("#floorBaseLevel");
const coverageValue = document.querySelector("#coverageValue");
const projectionResolution = document.querySelector("#projectionResolution");
const previewResolution = document.querySelector("#previewResolution");
const sourceResolution = document.querySelector("#sourceResolution");
const webappFramerate = document.querySelector("#webappFramerate");

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
const BRIDGE_PROXY_PATH = "/bridge";
const CUSTOM_SOURCE_VALUE = "__custom__";
const BRIDGE_PACKET_MAGIC = "WCP1";
const BRIDGE_PACKET_KIND_VIDEO = 1;
const BRIDGE_PACKET_KIND_AUDIO = 2;
const BRIDGE_PACKET_HEADER_BYTES = 13;
const BRIDGE_AUDIO_HEADER_BYTES = 24;
const BRIDGE_AV_BUFFER_SECONDS = 0.2;
const BRIDGE_AUDIO_RESET_GAP_SECONDS = 0.75;
const BRIDGE_UNDEFINED_TIMESTAMP = 9223372036854775807n;
const BRIDGE_AUDIO_RESYNC_TOLERANCE_SECONDS = 0.08;

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

const floorSpillUniforms = {
  projectionMap: { value: null },
  floorRadius: { value: BASE_RADIUS * 0.78 },
  coverageRadians: { value: Math.PI * 2 },
  baseColor: { value: new THREE.Color("#071019") },
  baseLevel: { value: Number(floorBaseLevelInput.value) || 1 },
  spillIntensity: { value: Number(floorSpillIntensityInput.value) || 1 },
  spillBlur: { value: Number(floorSpillBlurInput.value) || 1 },
  spillFalloff: { value: Number(floorSpillFalloffInput.value) || 0.82 },
};

const floorMaterial = new THREE.ShaderMaterial({
  uniforms: floorSpillUniforms,
  transparent: true,
  side: THREE.DoubleSide,
  toneMapped: false,
  vertexShader: `
    varying vec3 vWorldPosition;

    void main() {
      vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D projectionMap;
    uniform float floorRadius;
    uniform float coverageRadians;
    uniform vec3 baseColor;
    uniform float baseLevel;
    uniform float spillIntensity;
    uniform float spillBlur;
    uniform float spillFalloff;

    varying vec3 vWorldPosition;

    const float PI = 3.141592653589793;

    vec3 sampleProjection(float u) {
      float wrappedU = fract(u);
      return texture2D(projectionMap, vec2(wrappedU, 0.18)).rgb * 0.08 +
        texture2D(projectionMap, vec2(wrappedU, 0.34)).rgb * 0.12 +
        texture2D(projectionMap, vec2(wrappedU, 0.54)).rgb * 0.2 +
        texture2D(projectionMap, vec2(wrappedU, 0.74)).rgb * 0.26 +
        texture2D(projectionMap, vec2(wrappedU, 0.9)).rgb * 0.34;
    }

    void main() {
      vec2 floorPoint = vWorldPosition.xz;
      float radius = length(floorPoint);
      float normalizedRadius = clamp(radius / max(floorRadius, 0.0001), 0.0, 1.0);
      float angleFromNorth = atan(floorPoint.x, -floorPoint.y);
      float halfCoverage = min(coverageRadians * 0.5, PI);
      float coverageMask = 1.0 - smoothstep(halfCoverage * 0.97, halfCoverage + 0.05, abs(angleFromNorth));
      float angleU = angleFromNorth / max(coverageRadians, 0.0001) + 0.5;
      float blurAmount = mix(0.018, 0.006, normalizedRadius) * spillBlur;
      vec3 spillColor =
        sampleProjection(angleU - blurAmount) * 0.24 +
        sampleProjection(angleU) * 0.52 +
        sampleProjection(angleU + blurAmount) * 0.24;
      float luminance = dot(spillColor, vec3(0.2126, 0.7152, 0.0722));
      float radialFalloff = mix(0.18, 1.0, pow(normalizedRadius, max(spillFalloff, 0.001)));
      float edgeFade = 1.0 - smoothstep(0.9, 1.0, normalizedRadius);
      float spillStrength = spillIntensity * coverageMask * radialFalloff * edgeFade * (0.24 + pow(clamp(luminance, 0.0, 1.0), 0.9) * 1.5);
      vec3 color = baseColor * baseLevel + spillColor * spillStrength;
      gl_FragColor = vec4(color, 0.92);
    }
  `,
});

const ground = new THREE.Mesh(
  new THREE.CircleGeometry(BASE_RADIUS * 0.78, 96),
  floorMaterial,
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
floorSpillUniforms.projectionMap.value = projectionTexture;

const cylinderMaterial = new THREE.MeshBasicMaterial({
  map: projectionTexture,
  side: THREE.BackSide,
});

const silhouetteMaterial = new THREE.MeshBasicMaterial({
  color: "#0a0a0a",
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.9,
});

const silhouettesGroup = new THREE.Group();
scene.add(silhouettesGroup);

let cylinderMesh = null;
let activeStream = null;
let bridgeSocket = null;
let bridgeImageBitmap = null;
let bridgeVideoQueue = [];
let bridgeAudioContext = null;
let bridgeAudioWorkletLoaded = false;
let bridgeAudioWorkletNode = null;
let bridgeAudioChannelCount = 0;
let bridgeAudioGainNode = null;
let bridgeTimelineBaseTimestamp = null;
let bridgeTimelineBaseClock = null;
let bridgeTimelineClockMode = null;
let bridgeAudioBufferedUntilTimestampSeconds = null;
let isHudOpen = true;
let cylinderDiameterMeters = Number(diameterInput.value) || BASE_RADIUS * 2;
let cylinderHeightMeters = Number(heightInput.value) || BASE_SCREEN_HEIGHT;
let viewerEyeHeightMeters = Number(eyeHeightInput.value) || 1.7;
let silhouetteCount = Math.max(0, Math.round(Number(silhouetteCountInput.value) || 8));
let ambientFillIntensity = Number(ambientLightIntensityInput.value) || 1.5;
let floorSpillIntensity = Number(floorSpillIntensityInput.value) || 1;
let floorSpillBlur = Number(floorSpillBlurInput.value) || 1;
let floorSpillFalloff = Number(floorSpillFalloffInput.value) || 0.82;
let floorBaseLevel = Number(floorBaseLevelInput.value) || 1;
let sourceState = {
  mode: "demo",
  info: `Demo test pattern is active. Preview texture ${PREVIEW_LABEL}.`,
};
let managedSourceItemsByMode = {
  syphon: [],
  ndi: [],
};
let lastRenderTime = null;
let smoothedFps = null;

function createSilhouette(heightMeters) {
  const silhouette = new THREE.Group();
  const shoulderWidth = heightMeters * 0.23;
  const torsoWidth = heightMeters * 0.16;
  const torsoHeight = heightMeters * 0.52;
  const legWidth = torsoWidth * 0.42;
  const legHeight = heightMeters * 0.34;
  const headRadius = heightMeters * 0.07;
  const armWidth = torsoWidth * 0.34;
  const armHeight = torsoHeight * 0.7;

  const torso = new THREE.Mesh(
    new THREE.PlaneGeometry(torsoWidth, torsoHeight),
    silhouetteMaterial,
  );
  torso.position.y = legHeight + torsoHeight / 2;
  silhouette.add(torso);

  const head = new THREE.Mesh(
    new THREE.CircleGeometry(headRadius, 24),
    silhouetteMaterial,
  );
  head.position.y = legHeight + torsoHeight + headRadius * 1.5;
  silhouette.add(head);

  const leftLeg = new THREE.Mesh(
    new THREE.PlaneGeometry(legWidth, legHeight),
    silhouetteMaterial,
  );
  leftLeg.position.set(-legWidth * 0.65, legHeight / 2, 0);
  silhouette.add(leftLeg);

  const rightLeg = new THREE.Mesh(
    new THREE.PlaneGeometry(legWidth, legHeight),
    silhouetteMaterial,
  );
  rightLeg.position.set(legWidth * 0.65, legHeight / 2, 0);
  silhouette.add(rightLeg);

  const shoulderBar = new THREE.Mesh(
    new THREE.PlaneGeometry(shoulderWidth, torsoHeight * 0.16),
    silhouetteMaterial,
  );
  shoulderBar.position.y = legHeight + torsoHeight * 0.87;
  silhouette.add(shoulderBar);

  const leftArm = new THREE.Mesh(
    new THREE.PlaneGeometry(armWidth, armHeight),
    silhouetteMaterial,
  );
  leftArm.position.set(-(shoulderWidth / 2 - armWidth / 2), legHeight + torsoHeight * 0.53, 0);
  silhouette.add(leftArm);

  const rightArm = new THREE.Mesh(
    new THREE.PlaneGeometry(armWidth, armHeight),
    silhouetteMaterial,
  );
  rightArm.position.set(shoulderWidth / 2 - armWidth / 2, legHeight + torsoHeight * 0.53, 0);
  silhouette.add(rightArm);

  return silhouette;
}

function formatResolution(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return "Waiting.";
  }

  return `${Math.round(width)} x ${Math.round(height)}`;
}

function formatFps(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "Waiting.";
  }

  return `${value.toFixed(1)} fps`;
}

function updateWebappFramerate(now) {
  if (lastRenderTime !== null) {
    const deltaSeconds = (now - lastRenderTime) / 1000;
    if (deltaSeconds > 0) {
      const instantaneousFps = 1 / deltaSeconds;
      smoothedFps =
        smoothedFps === null
          ? instantaneousFps
          : smoothedFps * 0.9 + instantaneousFps * 0.1;
    }
  }

  lastRenderTime = now;
  webappFramerate.textContent = formatFps(smoothedFps);
}

function updateResolutionInfo() {
  projectionResolution.textContent = formatResolution(PROJECTION_WIDTH, PROJECTION_HEIGHT);
  previewResolution.textContent = formatResolution(PREVIEW_WIDTH, PREVIEW_HEIGHT);

  if (sourceState.mode === "video") {
    sourceResolution.textContent = formatResolution(videoElement.videoWidth, videoElement.videoHeight);
    return;
  }

  if (sourceState.mode === "bridge") {
    sourceResolution.textContent = formatResolution(
      bridgeImageBitmap?.width ?? 0,
      bridgeImageBitmap?.height ?? 0,
    );
    return;
  }

  if (sourceState.mode === "demo") {
    sourceResolution.textContent = `${formatResolution(PREVIEW_WIDTH, PREVIEW_HEIGHT)} generated`;
    return;
  }

  sourceResolution.textContent = "Waiting.";
}

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

function shouldUseBridgeProxy() {
  return import.meta.env.DEV || window.location.protocol === "https:";
}

function getBridgeFrameUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  if (shouldUseBridgeProxy()) {
    return `${protocol}//${window.location.host}${BRIDGE_PROXY_PATH}/frames`;
  }
  return `${protocol}//${getBridgeHost()}:${BRIDGE_PORT}/frames`;
}

function getBridgeControlBaseUrl() {
  if (shouldUseBridgeProxy()) {
    return `${window.location.origin}${BRIDGE_PROXY_PATH}`;
  }

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

function updateViewerEyeHeight({ normalizeInput = false } = {}) {
  const parsedEyeHeight = parsePositiveNumber(eyeHeightInput.value);
  if (parsedEyeHeight !== null) {
    viewerEyeHeightMeters = parsedEyeHeight;
  }

  camera.position.y = viewerEyeHeightMeters;
  controls.target.set(0, viewerEyeHeightMeters, -1);
  controls.update();

  if (normalizeInput) {
    eyeHeightInput.value = viewerEyeHeightMeters.toFixed(2);
  }
}

function rebuildSilhouettes(radius, cylinderHeight) {
  silhouettesGroup.clear();

  if (silhouetteCount <= 0) {
    return;
  }

  const usableRadius = radius * 0.72;
  const innerRadius = Math.min(usableRadius * 0.52, Math.max(1.5, radius * 0.2));
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));

  for (let index = 0; index < silhouetteCount; index += 1) {
    const heightMeters = Math.min(
      SILHOUETTE_HEIGHTS[index % SILHOUETTE_HEIGHTS.length],
      cylinderHeight * 0.92,
    );
    const silhouette = createSilhouette(heightMeters);
    const normalizedIndex = silhouetteCount === 1 ? 0.5 : (index + 0.5) / silhouetteCount;
    const distance = innerRadius + (usableRadius - innerRadius) * Math.sqrt(normalizedIndex);
    const angle = index * goldenAngle + Math.PI * 0.18;
    const x = Math.cos(angle) * distance;
    const z = Math.sin(angle) * distance;

    silhouette.position.set(x, 0, z);
    silhouette.lookAt(0, heightMeters * 0.52, 0);
    silhouettesGroup.add(silhouette);
  }
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

function parseNonNegativeNumber(value) {
  if (value.trim() === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
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

function syncLightingControls({ normalize = false } = {}) {
  const parsedAmbientFill = parseNonNegativeNumber(ambientLightIntensityInput.value);
  const parsedSpillIntensity = parseNonNegativeNumber(floorSpillIntensityInput.value);
  const parsedSpillBlur = parsePositiveNumber(floorSpillBlurInput.value);
  const parsedSpillFalloff = parsePositiveNumber(floorSpillFalloffInput.value);
  const parsedFloorBase = parseNonNegativeNumber(floorBaseLevelInput.value);

  if (parsedAmbientFill !== null) {
    ambientFillIntensity = parsedAmbientFill;
  }

  if (parsedSpillIntensity !== null) {
    floorSpillIntensity = parsedSpillIntensity;
  }

  if (parsedSpillBlur !== null) {
    floorSpillBlur = parsedSpillBlur;
  }

  if (parsedSpillFalloff !== null) {
    floorSpillFalloff = parsedSpillFalloff;
  }

  if (parsedFloorBase !== null) {
    floorBaseLevel = parsedFloorBase;
  }

  ambient.intensity = ambientFillIntensity;
  floorSpillUniforms.spillIntensity.value = floorSpillIntensity;
  floorSpillUniforms.spillBlur.value = floorSpillBlur;
  floorSpillUniforms.spillFalloff.value = floorSpillFalloff;
  floorSpillUniforms.baseLevel.value = floorBaseLevel;

  if (normalize) {
    ambientLightIntensityInput.value = ambientFillIntensity.toFixed(2);
    floorSpillIntensityInput.value = floorSpillIntensity.toFixed(2);
    floorSpillBlurInput.value = floorSpillBlur.toFixed(2);
    floorSpillFalloffInput.value = floorSpillFalloff.toFixed(2);
    floorBaseLevelInput.value = floorBaseLevel.toFixed(2);
  }
}

function rebuildCylinder({ normalizeInputs = false } = {}) {
  const diameterMeters = Math.max(cylinderDiameterMeters, 0.1);
  const heightMeters = Math.max(cylinderHeightMeters, 0.1);
  const radius = diameterMeters / 2;
  const derivedCoverageDegrees = updateCoverageLabel(diameterMeters, heightMeters);
  const coverageDegrees = THREE.MathUtils.clamp(derivedCoverageDegrees, 1, 360);
  const floorRadius = radius * 0.78;

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
  floorSpillUniforms.floorRadius.value = floorRadius;
  floorSpillUniforms.coverageRadians.value = thetaLength;
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

  rebuildSilhouettes(radius, heightMeters);
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

function syncSilhouetteCount({ normalize = false } = {}) {
  const parsedCount = Number.parseInt(silhouetteCountInput.value, 10);
  if (Number.isFinite(parsedCount)) {
    silhouetteCount = THREE.MathUtils.clamp(parsedCount, 0, 40);
  }

  if (normalize) {
    silhouetteCountInput.value = String(silhouetteCount);
  }

  rebuildCylinder();
}

function stopActiveStream() {
  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }
}

function disconnectBridge({ closeAudioContext = true } = {}) {
  if (bridgeSocket) {
    bridgeSocket.close();
    bridgeSocket = null;
  }

  if (bridgeImageBitmap) {
    bridgeImageBitmap.close();
    bridgeImageBitmap = null;
  }

  bridgeVideoQueue.forEach((frame) => {
    frame.bitmap.close();
  });
  bridgeVideoQueue = [];
  bridgeTimelineBaseTimestamp = null;
  bridgeTimelineBaseClock = null;
  bridgeTimelineClockMode = null;
  bridgeAudioBufferedUntilTimestampSeconds = null;

  if (bridgeAudioWorkletNode) {
    bridgeAudioWorkletNode.port.postMessage({ type: "reset" });
  }

  if (closeAudioContext && bridgeAudioContext) {
    if (bridgeAudioWorkletNode) {
      bridgeAudioWorkletNode.disconnect();
      bridgeAudioWorkletNode = null;
    }
    void bridgeAudioContext.close();
    bridgeAudioContext = null;
    bridgeAudioWorkletLoaded = false;
    bridgeAudioChannelCount = 0;
    bridgeAudioGainNode = null;
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

async function ensureBridgeAudioContext() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    return null;
  }

  if (!bridgeAudioContext) {
    bridgeAudioContext = new AudioContextClass({
      latencyHint: "interactive",
      sampleRate: 48000,
    });
    bridgeAudioGainNode = bridgeAudioContext.createGain();
    bridgeAudioGainNode.gain.value = 1;
    bridgeAudioGainNode.connect(bridgeAudioContext.destination);
  }

  if (!bridgeAudioWorkletLoaded) {
    if (!bridgeAudioContext.audioWorklet) {
      throw new Error("AudioWorklet is not supported in this browser.");
    }
    await bridgeAudioContext.audioWorklet.addModule(new URL("./bridge-audio-worklet.js", import.meta.url));
    bridgeAudioWorkletLoaded = true;
  }

  if (bridgeAudioContext.state === "suspended") {
    try {
      await bridgeAudioContext.resume();
    } catch {
      // Leave the context suspended; audio packets will be ignored until resumed.
    }
  }

  return bridgeAudioContext;
}

function ensureBridgeAudioWorkletNode(channelCount) {
  if (!bridgeAudioContext || !bridgeAudioGainNode || !bridgeAudioWorkletLoaded) {
    return null;
  }

  const normalizedChannelCount = THREE.MathUtils.clamp(channelCount, 1, 8);
  if (bridgeAudioWorkletNode && bridgeAudioChannelCount === normalizedChannelCount) {
    return bridgeAudioWorkletNode;
  }

  if (bridgeAudioWorkletNode) {
    bridgeAudioWorkletNode.disconnect();
    bridgeAudioWorkletNode = null;
  }

  bridgeAudioWorkletNode = new AudioWorkletNode(bridgeAudioContext, "bridge-audio-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [normalizedChannelCount],
    channelCount: normalizedChannelCount,
    channelCountMode: "explicit",
    channelInterpretation: "speakers",
  });
  bridgeAudioWorkletNode.connect(bridgeAudioGainNode);
  bridgeAudioWorkletNode.port.postMessage({
    type: "configure",
    channelCount: normalizedChannelCount,
    prebufferSeconds: BRIDGE_AV_BUFFER_SECONDS,
  });
  bridgeAudioChannelCount = normalizedChannelCount;
  return bridgeAudioWorkletNode;
}

function getBridgeClockNow(mode = bridgeTimelineClockMode) {
  if (mode === "audio" && bridgeAudioContext) {
    return bridgeAudioContext.currentTime;
  }

  return performance.now() / 1000;
}

function resetBridgeTimeline(timestampSeconds, mode) {
  bridgeTimelineBaseTimestamp = timestampSeconds;
  bridgeTimelineClockMode = mode;
  bridgeTimelineBaseClock = getBridgeClockNow(mode) + BRIDGE_AV_BUFFER_SECONDS;
}

function ensureBridgeTimeline(timestampSeconds, preferredMode) {
  if (timestampSeconds === null) {
    return;
  }

  if (
    bridgeTimelineBaseTimestamp === null ||
    bridgeTimelineBaseClock === null ||
    bridgeTimelineClockMode !== preferredMode
  ) {
    resetBridgeTimeline(timestampSeconds, preferredMode);
  }
}

function parseBridgeTimestamp(dataView) {
  if (typeof dataView.getBigInt64 !== "function") {
    return null;
  }

  const rawTimestamp = dataView.getBigInt64(5, true);
  if (rawTimestamp < 0 || rawTimestamp === BRIDGE_UNDEFINED_TIMESTAMP) {
    return null;
  }

  return Number(rawTimestamp) / 1e7;
}

function deinterleaveBridgeAudio(samplePayload, channelCount, sampleFrames) {
  const channels = Array.from(
    { length: channelCount },
    () => new Float32Array(sampleFrames),
  );

  for (let sampleIndex = 0; sampleIndex < sampleFrames; sampleIndex += 1) {
    for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
      channels[channelIndex][sampleIndex] =
        samplePayload[sampleIndex * channelCount + channelIndex];
    }
  }

  return channels;
}

function resampleAudioChannel(channelData, inputSampleRate, outputSampleRate) {
  if (inputSampleRate === outputSampleRate) {
    return channelData;
  }

  const outputLength = Math.max(
    1,
    Math.round((channelData.length * outputSampleRate) / inputSampleRate),
  );
  const output = new Float32Array(outputLength);
  const ratio = inputSampleRate / outputSampleRate;

  for (let index = 0; index < outputLength; index += 1) {
    const position = index * ratio;
    const leftIndex = Math.floor(position);
    const rightIndex = Math.min(leftIndex + 1, channelData.length - 1);
    const mix = position - leftIndex;
    output[index] =
      channelData[leftIndex] * (1 - mix) + channelData[rightIndex] * mix;
  }

  return output;
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

function enqueueBridgeVideoFrame(imageData, timestampSeconds) {
  const blob = new Blob([imageData], { type: "image/jpeg" });
  createImageBitmap(blob).then((bitmap) => {
    if (timestampSeconds === null) {
      if (bridgeImageBitmap) {
        bridgeImageBitmap.close();
      }
      bridgeImageBitmap = bitmap;
      return;
    }

    ensureBridgeTimeline(timestampSeconds, bridgeAudioContext ? "audio" : "performance");
    bridgeVideoQueue.push({ bitmap, timestampSeconds });
    bridgeVideoQueue.sort((left, right) => left.timestampSeconds - right.timestampSeconds);
  });
}

function flushBridgeVideoQueue() {
  if (bridgeVideoQueue.length === 0) {
    return;
  }

  if (
    bridgeTimelineBaseTimestamp === null ||
    bridgeTimelineBaseClock === null ||
    bridgeTimelineClockMode === null
  ) {
    const latestFrame = bridgeVideoQueue.pop();
    bridgeVideoQueue.forEach((frame) => frame.bitmap.close());
    bridgeVideoQueue = [];
    if (latestFrame) {
      if (bridgeImageBitmap) {
        bridgeImageBitmap.close();
      }
      bridgeImageBitmap = latestFrame.bitmap;
    }
    return;
  }

  const mediaTime =
    bridgeTimelineBaseTimestamp + (getBridgeClockNow(bridgeTimelineClockMode) - bridgeTimelineBaseClock);
  let lastReadyIndex = -1;
  for (let index = 0; index < bridgeVideoQueue.length; index += 1) {
    if (bridgeVideoQueue[index].timestampSeconds <= mediaTime + 0.01) {
      lastReadyIndex = index;
    } else {
      break;
    }
  }

  if (lastReadyIndex < 0) {
    return;
  }

  const readyFrames = bridgeVideoQueue.splice(0, lastReadyIndex + 1);
  const nextFrame = readyFrames.pop();
  readyFrames.forEach((frame) => frame.bitmap.close());

  if (nextFrame) {
    if (bridgeImageBitmap) {
      bridgeImageBitmap.close();
    }
    bridgeImageBitmap = nextFrame.bitmap;
  }
}

async function handleBridgeAudioPacket(dataView) {
  if (!bridgeAudioContext || !bridgeAudioGainNode) {
    return;
  }

  const timestampSeconds = parseBridgeTimestamp(dataView);
  const sampleRate = dataView.getUint32(13, true);
  const channelCount = dataView.getUint16(17, true);
  const sampleFrames = dataView.getUint32(19, true);
  if (sampleRate <= 0 || channelCount <= 0 || sampleFrames <= 0) {
    return;
  }

  const workletNode = ensureBridgeAudioWorkletNode(channelCount);
  if (!workletNode) {
    return;
  }

  const samplePayload = new Float32Array(
    dataView.buffer,
    dataView.byteOffset + BRIDGE_AUDIO_HEADER_BYTES,
    sampleFrames * channelCount,
  );
  const sourceChannels = deinterleaveBridgeAudio(samplePayload, channelCount, sampleFrames);
  const processedChannels = sourceChannels.map((channelData) =>
    resampleAudioChannel(channelData, sampleRate, bridgeAudioContext.sampleRate),
  );
  const processedFrameCount = processedChannels[0]?.length ?? 0;
  if (processedFrameCount <= 0) {
    return;
  }

  if (timestampSeconds !== null) {
    const shouldResetTimeline =
      bridgeTimelineBaseTimestamp === null ||
      bridgeTimelineBaseClock === null ||
      bridgeTimelineClockMode !== "audio" ||
      bridgeAudioBufferedUntilTimestampSeconds === null ||
      timestampSeconds < bridgeAudioBufferedUntilTimestampSeconds - BRIDGE_AUDIO_RESYNC_TOLERANCE_SECONDS ||
      timestampSeconds - bridgeAudioBufferedUntilTimestampSeconds > BRIDGE_AUDIO_RESET_GAP_SECONDS;

    if (shouldResetTimeline) {
      resetBridgeTimeline(timestampSeconds, "audio");
      bridgeAudioBufferedUntilTimestampSeconds = timestampSeconds;
      workletNode.port.postMessage({ type: "reset" });
    }

    bridgeAudioBufferedUntilTimestampSeconds = Math.max(
      bridgeAudioBufferedUntilTimestampSeconds ?? timestampSeconds,
      timestampSeconds + processedFrameCount / bridgeAudioContext.sampleRate,
    );
  }

  workletNode.port.postMessage(
    {
      type: "enqueue",
      channelCount,
      frameCount: processedFrameCount,
      channels: processedChannels.map((channelData) => channelData.buffer),
    },
    processedChannels.map((channelData) => channelData.buffer),
  );
}

function parseBridgePacket(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < BRIDGE_PACKET_HEADER_BYTES) {
    return null;
  }

  const signature = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
  if (signature !== BRIDGE_PACKET_MAGIC) {
    return null;
  }

  const dataView = new DataView(buffer);
  return {
    kind: dataView.getUint8(4),
    dataView,
    timestampSeconds: parseBridgeTimestamp(dataView),
  };
}

function activateBridgeSource() {
  stopActiveStream();
  resetVideoElement();
  disconnectBridge({ closeAudioContext: false });

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

    const packet = parseBridgePacket(event.data);
    if (!packet) {
      handleBridgeFrame(event.data);
      return;
    }

    if (packet.kind === BRIDGE_PACKET_KIND_VIDEO) {
      enqueueBridgeVideoFrame(
        event.data.slice(BRIDGE_PACKET_HEADER_BYTES),
        packet.timestampSeconds,
      );
      return;
    }

    if (packet.kind === BRIDGE_PACKET_KIND_AUDIO) {
      handleBridgeAudioPacket(packet.dataView);
      return;
    }
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
  disconnectBridge({ closeAudioContext: false });

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
    if (mode === "bridge" || isManagedSourceMode(mode)) {
      await ensureBridgeAudioContext();
    }
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
  flushBridgeVideoQueue();
  if (!bridgeImageBitmap) {
    return;
  }

  textureContext.drawImage(bridgeImageBitmap, 0, 0, textureCanvas.width, textureCanvas.height);
}

function drawMonitor() {
  monitorContext.drawImage(textureCanvas, 0, 0, monitorCanvas.width, monitorCanvas.height);
}

function renderFrame(now) {
  updateWebappFramerate(now);

  if (sourceState.mode === "demo") {
    drawDemo(now);
  } else if (sourceState.mode === "video") {
    drawVideoSource();
  } else if (sourceState.mode === "bridge") {
    drawBridgeSource();
  }

  updateResolutionInfo();
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
eyeHeightInput.addEventListener("input", () => {
  updateViewerEyeHeight();
});
silhouetteCountInput.addEventListener("input", () => {
  syncSilhouetteCount();
});
ambientLightIntensityInput.addEventListener("input", () => {
  syncLightingControls();
});
floorSpillIntensityInput.addEventListener("input", () => {
  syncLightingControls();
});
floorSpillBlurInput.addEventListener("input", () => {
  syncLightingControls();
});
floorSpillFalloffInput.addEventListener("input", () => {
  syncLightingControls();
});
floorBaseLevelInput.addEventListener("input", () => {
  syncLightingControls();
});
diameterInput.addEventListener("change", () => {
  syncCylinderInputs({ normalize: true });
});
heightInput.addEventListener("change", () => {
  syncCylinderInputs({ normalize: true });
});
eyeHeightInput.addEventListener("change", () => {
  updateViewerEyeHeight({ normalizeInput: true });
});
silhouetteCountInput.addEventListener("change", () => {
  syncSilhouetteCount({ normalize: true });
});
ambientLightIntensityInput.addEventListener("change", () => {
  syncLightingControls({ normalize: true });
});
floorSpillIntensityInput.addEventListener("change", () => {
  syncLightingControls({ normalize: true });
});
floorSpillBlurInput.addEventListener("change", () => {
  syncLightingControls({ normalize: true });
});
floorSpillFalloffInput.addEventListener("change", () => {
  syncLightingControls({ normalize: true });
});
floorBaseLevelInput.addEventListener("change", () => {
  syncLightingControls({ normalize: true });
});
diameterInput.addEventListener("blur", () => {
  syncCylinderInputs({ normalize: true });
});
heightInput.addEventListener("blur", () => {
  syncCylinderInputs({ normalize: true });
});
eyeHeightInput.addEventListener("blur", () => {
  updateViewerEyeHeight({ normalizeInput: true });
});
silhouetteCountInput.addEventListener("blur", () => {
  syncSilhouetteCount({ normalize: true });
});
ambientLightIntensityInput.addEventListener("blur", () => {
  syncLightingControls({ normalize: true });
});
floorSpillIntensityInput.addEventListener("blur", () => {
  syncLightingControls({ normalize: true });
});
floorSpillBlurInput.addEventListener("blur", () => {
  syncLightingControls({ normalize: true });
});
floorSpillFalloffInput.addEventListener("blur", () => {
  syncLightingControls({ normalize: true });
});
floorBaseLevelInput.addEventListener("blur", () => {
  syncLightingControls({ normalize: true });
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

updateViewerEyeHeight({ normalizeInput: true });
syncSilhouetteCount({ normalize: true });
syncLightingControls({ normalize: true });
syncCylinderInputs({ normalize: true });
syncSourceFields();
renderProtocolTargetOptions(sourceModeSelect.value);
updateResolutionInfo();
setHudOpen(true);
activateDemoSource();
renderer.setAnimationLoop(renderFrame);
