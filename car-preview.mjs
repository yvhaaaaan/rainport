import * as THREE from 'three';
import {createRaceCar} from './car-model.mjs';

const selector = 'canvas.car-preview[data-car-preview]';
const anchors = [
  {point: [0, .83, 1.30], offset: [9, -16]},
  {point: [.898, .35, -1.36], offset: [0, -13]},
  {point: [0, .94, 1.94], offset: [-8, -11]},
];
const targets = new Map();
const pending = new Set();
const rearImages = new Map();
const srgb = Array.from({length: 256}, (_, index) => {
  const linear = index / 255;
  return Math.round(255 * (linear <= .0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - .055));
});
let frame = 0;
let studio;
let rearModel;
let resized;
let intersected;

function makeStudio(appearance) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera();
  camera.position.set(6.6, 4.4, 7.1);
  camera.lookAt(0, .60, 0);
  const fill = new THREE.HemisphereLight(0xfff5e8, 0x626d76, 2.1);
  const key = new THREE.DirectionalLight(0xfff4e6, 2.5);
  const rim = new THREE.DirectionalLight(0xd1eaff, 2.3);
  key.position.set(3, 8, 2);
  rim.position.set(-5, 4, -3);
  scene.add(fill, key, rim);
  const car = createRaceCar(THREE, {appearance, studio: true});
  scene.add(car.object);
  let renderer = null;
  let lost = false;
  const surface = document.createElement('canvas');
  try {
    const options = {alpha: true, antialias: true, powerPreference: 'low-power'};
    const context = surface.getContext('webgl2', options);
    if (context) {
      renderer = new THREE.WebGLRenderer({canvas: surface, context, ...options});
      renderer.setClearColor(0, 0);
      surface.addEventListener('webglcontextlost', event => {
        event.preventDefault();
        lost = true;
        for (const canvas of targets.keys()) queuePreview(canvas);
      });
      surface.addEventListener('webglcontextrestored', () => {
        lost = false;
        for (const canvas of targets.keys()) queuePreview(canvas);
      });
    }
  } catch {
    // The same model can be projected onto a 2D canvas on devices without WebGL 2.
  }
  return {car, scene, camera, get renderer() { return lost ? null : renderer; }};
}

function pointOnCanvas(camera, point, width, height) {
  const p = new THREE.Vector3(...point).project(camera);
  return [(p.x + 1) * width / 2, (1 - p.y) * height / 2];
}

function placePins(canvas, camera, width, height) {
  const holder = canvas.closest('.car-studio');
  const labels = [];
  for (const pin of holder?.querySelectorAll('[data-part-anchor]') || []) {
    const anchor = anchors[Number(pin.dataset.partAnchor)];
    if (!anchor) continue;
    const [x, y] = pointOnCanvas(camera, anchor.point, width, height);
    const [horizontal, vertical] = anchor.offset;
    const half = pin.offsetWidth / 2, labelHeight = pin.offsetHeight;
    const margin = Math.min(width / 3, half + 5);
    const labelX = THREE.MathUtils.clamp(x + horizontal * width / 100, margin, width - margin);
    const preferredY = y + vertical * height / 100;
    const neighbors = labels.filter(label => Math.abs(label.x - labelX) < label.half + half + 4);
    const candidates = [preferredY, ...neighbors.flatMap(label => [label.top - 4, label.bottom + labelHeight + 4])]
      .filter(bottom => bottom >= labelHeight + 4 && bottom <= height - 4 &&
        neighbors.every(label => bottom <= label.top - 4 || bottom - labelHeight >= label.bottom + 4));
    candidates.sort((a, b) => Math.abs(a - preferredY) - Math.abs(b - preferredY));
    const labelY = candidates[0] ?? THREE.MathUtils.clamp(preferredY, labelHeight + 4, height - 4);
    labels.push({x: labelX, half, bottom: labelY, top: labelY - labelHeight});
    const above = y < labelY - labelHeight / 2;
    const dx = x - labelX, dy = y - (above ? labelY - labelHeight : labelY);
    pin.style.left = labelX / width * 100 + '%';
    pin.style.top = labelY / height * 100 + '%';
    pin.style.setProperty('--leader-length', Math.hypot(dx, dy) + 'px');
    pin.style.setProperty('--leader-angle', -Math.atan2(dx, dy) + 'rad');
    pin.setAttribute('data-anchored', '');
    pin.toggleAttribute('data-leader-above', above);
  }
}

function drawStudioFloor(ctx, width, height, camera) {
  const floor = ctx.createLinearGradient(0, 0, 0, height);
  floor.addColorStop(0, '#aebfc6');
  floor.addColorStop(.61, '#dce2e2');
  floor.addColorStop(1, '#b8c6c8');
  ctx.fillStyle = floor;
  ctx.fillRect(0, 0, width, height);
  // A contact shadow grounds the model without adding racing effects or a second camera.
  const [x, y] = pointOnCanvas(camera, [0, .02, 0], width, height);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-.40);
  ctx.scale(width * .39, height * .18);
  const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  shadow.addColorStop(0, '#111e2c64');
  shadow.addColorStop(.54, '#111e2c3b');
  shadow.addColorStop(1, '#111e2c00');
  ctx.fillStyle = shadow;
  ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
}

function drawModel2d(ctx, model, camera, appearance, width, height) {
  const faces = [];
  const transform = new THREE.Matrix4();
  const projectedView = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const point = new THREE.Vector3();
  const light = new THREE.Vector3(.42, .84, .34).normalize();
  const orientation = new THREE.Matrix3();
  const finish = new THREE.Color(appearance.color);
  const tone = value => srgb[Math.floor(255 * THREE.MathUtils.clamp(value, 0, 1))];
  model.updateMatrixWorld(true);
  model.traverseVisible(mesh => {
    const geometry = mesh.geometry;
    const surface = geometry?.getAttribute('gtSurface');
    if (!surface) return;
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    const color = geometry.getAttribute('color');
    const indices = geometry.getIndex();
    const coordinates = new Float32Array(position.count * 3);
    transform.multiplyMatrices(projectedView, mesh.matrixWorld);
    orientation.getNormalMatrix(mesh.matrixWorld);
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(transform);
      coordinates.set([(point.x + 1) * width / 2, (1 - point.y) * height / 2, point.z], i * 3);
    }
    const count = indices?.count || position.count;
    for (let i = 0; i < count; i += 3) {
      const [a, b, c] = indices ? [indices.getX(i), indices.getX(i + 1), indices.getX(i + 2)] : [i, i + 1, i + 2];
      const x = a * 3, y = b * 3, z = c * 3;
      const angle = (coordinates[y] - coordinates[x]) * (coordinates[z + 1] - coordinates[x + 1]) -
        (coordinates[z] - coordinates[x]) * (coordinates[y + 1] - coordinates[x + 1]);
      if (Math.abs(angle) < .15) continue;
      const material = surface.getZ(a);
      const paint = material < .16;
      const brightness = .52 + .48 * Math.abs(point.fromBufferAttribute(normal, a).applyMatrix3(orientation).dot(light));
      const base = paint ? finish : {r: color.getX(a), g: color.getY(a), b: color.getZ(a)};
      const rgb = material > .84 ? 'rgb(250,46,49)' : material > .50 ? 'rgb(213,234,243)' :
        'rgb(' + tone(base.r * brightness) + ',' + tone(base.g * brightness) + ',' + tone(base.b * brightness) + ')';
      faces.push({coordinates, x, y, z, depth: coordinates[x + 2] + coordinates[y + 2] + coordinates[z + 2], rgb});
    }
  });
  faces.sort((a, b) => b.depth - a.depth);
  ctx.lineWidth = .5;
  for (const {coordinates, x, y, z, rgb} of faces) {
    ctx.beginPath();
    ctx.moveTo(coordinates[x], coordinates[x + 1]);
    ctx.lineTo(coordinates[y], coordinates[y + 1]);
    ctx.lineTo(coordinates[z], coordinates[z + 1]);
    ctx.closePath();
    ctx.fillStyle = ctx.strokeStyle = rgb;
    ctx.fill();
    ctx.stroke();
  }
  const [plateX, plateY] = pointOnCanvas(camera, [0, .435, 2.35], width, height);
  ctx.fillStyle = '#dddcd0';
  ctx.font = '700 ' + Math.max(8, width * .012) + 'px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(appearance.plate, plateX, plateY);
}

export function compatibleRearCar(appearance) {
  const key = [appearance.plate, appearance.color, ...appearance.spec].join('/');
  if (rearImages.has(key)) return rearImages.get(key);
  const car = rearModel ||= createRaceCar(THREE, {appearance, studio: true});
  car.setAppearance(appearance);
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 160;
  const camera = new THREE.OrthographicCamera(-1.60, 1.60, .80, -.80, .01, 16);
  camera.position.set(0, 1.26, 6.8);
  camera.lookAt(0, .52, 0);
  camera.updateMatrixWorld();
  drawModel2d(canvas.getContext('2d'), car.object, camera, appearance, canvas.width, canvas.height);
  const lights = [-1, 1].map(side =>
    [[.17, .523, 2.349], [.67, .503, 2.352], [.943, .536, 2.203]].map(([x, y, z]) =>
      pointOnCanvas(camera, [side * x, y, z], 1, 1)));
  const rear = {canvas, lights};
  if (rearImages.size >= 8) rearImages.delete(rearImages.keys().next().value);
  rearImages.set(key, rear);
  return rear;
}

function drawPreview(canvas, appearance) {
  const width = canvas.clientWidth, height = canvas.clientHeight;
  if (!width || !height || !appearance) return;
  const ctx = canvas.getContext('2d', {alpha: false});
  if (!ctx) return;
  if (!studio) studio = makeStudio(appearance);
  const {camera, car, scene, renderer} = studio;
  const aspect = width / height;
  const lensHeight = Math.max(3.2, 5.45 / aspect);
  camera.left = -lensHeight * aspect / 2;
  camera.right = -camera.left;
  camera.top = lensHeight / 2;
  camera.bottom = -camera.top;
  camera.near = .01;
  camera.far = 40;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  const density = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(950000 / (width * height)));
  const rw = Math.max(2, Math.round(width * density)), rh = Math.max(2, Math.round(height * density));
  if (canvas.width !== rw || canvas.height !== rh) {
    canvas.width = rw;
    canvas.height = rh;
  }
  drawStudioFloor(ctx, rw, rh, camera);
  car.setAppearance(appearance);
  car.update({spec: appearance.spec});
  let drawn = false;
  if (renderer) {
    renderer.setSize(rw, rh, false);
    try {
      renderer.render(scene, camera);
      if (!renderer.getContext().isContextLost()) {
        ctx.drawImage(renderer.domElement, 0, 0);
        drawn = true;
      }
    } catch {
      // Retain the compatible rendering when an active graphics device resets.
    }
  }
  if (!drawn) drawModel2d(ctx, car.object, camera, appearance, rw, rh);
  canvas.dataset.renderer = drawn ? 'webgl2' : 'canvas2d';
  placePins(canvas, camera, width, height);
}

function drawQueuedPreview() {
  frame = 0;
  const canvas = pending.values().next().value;
  if (!canvas) return;
  pending.delete(canvas);
  const entry = targets.get(canvas);
  if (entry?.visible && canvas.isConnected) drawPreview(canvas, entry.appearance);
  if (pending.size) frame = requestAnimationFrame(drawQueuedPreview);
}

function queuePreview(canvas) {
  if (!targets.get(canvas)?.visible) return;
  pending.add(canvas);
  if (!frame) frame = requestAnimationFrame(drawQueuedPreview);
}

export function renderCarPreviews(root, appearanceFor) {
  const canvases = new Set(root.querySelectorAll(selector));
  for (const canvas of targets.keys()) {
    if (canvases.has(canvas)) continue;
    resized?.unobserve(canvas);
    intersected?.unobserve(canvas);
    targets.delete(canvas);
    pending.delete(canvas);
  }
  if (!canvases.size) return;
  if (!resized && window.ResizeObserver) {
    resized = new ResizeObserver(entries => {
      for (const {target} of entries) queuePreview(target);
    });
  }
  if (!intersected && window.IntersectionObserver) {
    intersected = new IntersectionObserver(entries => {
      for (const {target, isIntersecting} of entries) {
        const entry = targets.get(target);
        if (!entry) continue;
        entry.visible = isIntersecting;
        if (isIntersecting) queuePreview(target);
      }
    });
  }
  for (const canvas of canvases) {
    const appearance = appearanceFor(canvas);
    if (targets.has(canvas)) {
      targets.get(canvas).appearance = appearance;
    } else {
      targets.set(canvas, {appearance, visible: !intersected});
      resized?.observe(canvas);
      intersected?.observe(canvas);
    }
    queuePreview(canvas);
  }
}
