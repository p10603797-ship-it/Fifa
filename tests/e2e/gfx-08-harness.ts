/**
 * GFX-08 e2e harness page entry (not a spec): the real kit atlas on real WebGL2 (three.js), bundled by
 * tests/e2e/gfx-08-kits.spec.ts with esbuild and injected into a blank page.
 *
 * Draws, for a fixture (home club, away club, high contrast):
 *  - top: close-up torsos (CylinderGeometry, the documented UV convention) in one InstancedMesh with applyKitUv and
 *    per-instance rects from atlas.shirtUv: home #10 front and back, away #7 front and back, both keepers front and
 *    back, unlit (MeshBasicMaterial) so pixel probes read the texture colour;
 *  - bottom left: the same kits lit (Lambert, one directional light + ambient) at broadcast distance, for the mip
 *    chain (an incomplete mip chain samples black);
 *  - middle left strip: createKitNumberAtlas glyphs composited with the players/model.ts torso formula
 *    (shirt * (1 - a) + outline * (a - r) + number * r) on 0.24 x 0.2 back panels, unlit;
 *  - bottom right: the atlas itself (2D canvas), kit previews (kitDataUrl) of the resolved kits and the 20 club
 *    crests as <img> from crestDataUrl.
 * window.__gfx08.show(home, away, hc) redraws; points() names the torso centres and pixels(x, y, w, h) reads a block.
 */
import {
  AmbientLight, CylinderGeometry, DirectionalLight, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, Object3D,
  OrthographicCamera, PerspectiveCamera, PlaneGeometry, Scene, ShaderMaterial, Vector3, Vector4, WebGLRenderer,
  type InstancedBufferAttribute,
} from 'three';
import { KitSlot } from '../../src/contracts/enums';
import { CLUBS } from '../../src/data/clubs';
import {
  KIT_UV_ATTRIBUTE, applyKitUv, createKitNumberAtlas, createKitSet, createKitUvAttribute, crestDataUrl, kitDataUrl, matchShirtNumbers,
  resolveKits, type MatchKits,
} from '../../src/render/kits';
import { createMatchConfig } from '../../src/contracts/state';
import { initMatch } from '../../src/sim/init';

export interface Gfx08Harness {
  ready: boolean;
  /** Redraw for a fixture; returns the resolved kits' colours. */
  show(home: number, away: number, highContrast: boolean): { shirt: number[]; keeper: number[]; number: number[] };
  /** Named points of the last frame (canvas px, top-left origin): front0 / back0 / front1 / back1 / k0 / k0back / k1 /
   *  k1back (close-up torso centres), far0 / far1 (broadcast-distance torso centres), g0..g5 (glyph panels). */
  points(): Record<string, [number, number]>;
  /** RGBA of a w x h block centred on (x, y) (canvas px, top-left origin), rows top to bottom. */
  pixels(x: number, y: number, w: number, h: number): number[];
  glError(): number;
  crestsLoaded(): number;
  kitsLoaded(): number;
}

declare global {
  interface Window { __gfx08?: Gfx08Harness }
}

const W = 1180, H = 820;
document.body.style.cssText = 'margin:0;background:#07070d;overflow:hidden';
const canvas = document.createElement('canvas');
canvas.width = W; canvas.height = H;
canvas.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px`;
document.body.appendChild(canvas);
const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.setClearColor(0x2f6b2a); // grass-ish backdrop so contrast with the pitch can be judged

const kitSet = createKitSet(renderer.capabilities.getMaxAnisotropy() >= 4 ? 4 : 1);
const torsoGeo = new CylinderGeometry(0.17, 0.15, 0.6, 32, 1, true);
const uvAttr: InstancedBufferAttribute = createKitUvAttribute(16);
torsoGeo.setAttribute(KIT_UV_ATTRIBUTE, uvAttr);

const flat = new MeshBasicMaterial({ map: kitSet.texture });
applyKitUv(flat);
const lit = new MeshLambertMaterial({ map: kitSet.texture });
applyKitUv(lit);
const close = new InstancedMesh(torsoGeo, flat, 8);
const far = new InstancedMesh(torsoGeo, lit, 8);
close.frustumCulled = false; far.frustumCulled = false;
const sceneClose = new Scene();
sceneClose.add(close);
const sceneFar = new Scene();
sceneFar.add(far, new AmbientLight(0xffffff, 1.2));
const sun = new DirectionalLight(0xffffff, 1.6);
sun.position.set(-3, 8, 6);
sceneFar.add(sun);

// Close-up: 8 torsos in a row, an orthographic camera looking along -z at them. Cylinder u 0.25 (chest) is +x in
// model space; rotate each so the wanted side faces the camera (+z).
const camClose = new OrthographicCamera(-2.2, 2.2, 0.62, -0.62, 0.1, 20);
camClose.position.set(0, 0, 5);
// Far: broadcast-like distance (about 45 m away, 22 degree vertical field of view).
const camFar = new PerspectiveCamera(22, (W / 2) / (H * 0.4), 1, 200);
camFar.position.set(0, 18, 42);
camFar.lookAt(0, 0.3, 0);

// Number glyph strip (GFX-07's torso composition with this module's glyph atlas).
const numberAtlas = createKitNumberAtlas();
const glyphScene = new Scene();
const glyphCam = new OrthographicCamera(0, 6 * 0.3, 0.25, 0, -1, 1);
const GLYPH_VS = 'uniform vec4 uRect; varying vec2 vUv; void main() { vUv = mix(uRect.xy, uRect.zw, uv); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
const GLYPH_FS = 'uniform sampler2D uTex; uniform vec3 uShirt; uniform vec3 uNum; uniform vec3 uOut; varying vec2 vUv;'
  + 'void main() { vec4 g = texture2D(uTex, vUv); gl_FragColor = vec4(uShirt * (1.0 - g.a) + uOut * max(g.a - g.r, 0.0) + uNum * g.r, 1.0); }';
const glyphMats: ShaderMaterial[] = [];
const panelGeo = new PlaneGeometry(0.24, 0.2);
for (let i = 0; i < 6; i++) {
  const mat = new ShaderMaterial({
    uniforms: { uTex: { value: numberAtlas.texture }, uRect: { value: new Vector4() }, uShirt: { value: new Vector3() }, uNum: { value: new Vector3() }, uOut: { value: new Vector3() } },
    vertexShader: GLYPH_VS, fragmentShader: GLYPH_FS,
  });
  glyphMats.push(mat);
  const q = new Mesh(panelGeo, mat);
  q.position.set(0.15 + i * 0.3, 0.125, 0);
  glyphScene.add(q);
}
const srgb = (c: number, v: Vector3): void => { v.set(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255); };
const lum = (c: number): number => {
  const f = (x: number): number => { const v = x / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f((c >> 16) & 255) + 0.7152 * f((c >> 8) & 255) + 0.0722 * f(c & 255);
};

const dummy = new Object3D();
const m4 = new Matrix4();
const order: [string, number, boolean, boolean][] = [ // name, team, keeper, back
  ['front0', 0, false, false], ['back0', 0, false, true], ['front1', 1, false, false], ['back1', 1, false, true],
  ['k0', 0, true, false], ['k0back', 0, true, true], ['k1', 1, true, false], ['k1back', 1, true, true],
];
const probePts: Record<string, [number, number]> = {};

function place(): void {
  for (let i = 0; i < 8; i++) {
    const [name, , , back] = order[i]!;
    const x = -1.925 + i * 0.55;
    dummy.position.set(x, 0, 0);
    // Chest (+x) toward the camera (+z): rotate -90 degrees about y; back: +90.
    dummy.rotation.set(0, back ? Math.PI / 2 : -Math.PI / 2, 0);
    dummy.updateMatrix();
    close.setMatrixAt(i, dummy.matrix);
    const px = ((x + 2.2) / 4.4) * W;
    probePts[name] = [Math.round(px), Math.round(H * 0.25)];
    // Far: two lines of four, facing the camera.
    dummy.position.set(-3 + (i % 4) * 2, 0.3, (i < 4 ? 0 : 3));
    dummy.updateMatrix();
    m4.copy(dummy.matrix);
    far.setMatrixAt(i, m4);
  }
  close.instanceMatrix.needsUpdate = true;
  far.instanceMatrix.needsUpdate = true;
}

const NUMBERS = [10, 10, 7, 7, 1, 1, 1, 1];
let kits: MatchKits | null = null;

function show(home: number, away: number, hc: boolean): { shirt: number[]; keeper: number[]; number: number[] } {
  const cfg = createMatchConfig();
  cfg.homeClub = home; cfg.awayClub = away;
  const s = initMatch(cfg);
  s.teams[0]!.clubIdx = home; s.teams[1]!.clubIdx = away;
  s.teams[0]!.kit = KitSlot.HOME; s.teams[1]!.kit = KitSlot.AWAY;
  kits = kitSet.setMatch(s, CLUBS, hc);
  const nums = matchShirtNumbers(s, CLUBS);
  const arr = uvAttr.array as Float32Array;
  for (let i = 0; i < 8; i++) {
    const [, team, keeper] = order[i]!;
    const n = nums[team]!.includes(NUMBERS[i]!) ? NUMBERS[i]! : nums[team]![0]!;
    kitSet.atlas.shirtUv(team, keeper, n, arr, i * 4);
  }
  uvAttr.needsUpdate = true;
  const panels: [number, number, number][] = [ // shirt, number colour, shirt number
    [kits.outfield[0].shirt, kits.outfield[0].number, 10], [kits.outfield[0].shirt, kits.outfield[0].number, 88],
    [kits.outfield[1].shirt, kits.outfield[1].number, 7], [kits.outfield[1].shirt, kits.outfield[1].number, 11],
    [kits.keeper[0].shirt, kits.keeper[0].number, 1], [kits.keeper[1].shirt, kits.keeper[1].number, 23],
  ];
  const rect = [0, 0, 0, 0];
  for (let i = 0; i < 6; i++) {
    const [shirt, num, n] = panels[i]!;
    const u = glyphMats[i]!.uniforms;
    numberAtlas.glyphRect(n, rect, 0);
    (u.uRect!.value as Vector4).set(rect[0]!, rect[1]!, rect[2]!, rect[3]!);
    srgb(shirt, u.uShirt!.value as Vector3);
    srgb(num, u.uNum!.value as Vector3);
    srgb(lum(num) > 0.35 ? 0x030303 : 0xe6e6e6, u.uOut!.value as Vector3);
  }
  kitBox.replaceChildren();
  for (const [kk, n] of [[kits.outfield[0], 10], [kits.outfield[1], 7], [kits.keeper[0], 1], [kits.keeper[1], 1]] as const) {
    const img = document.createElement('img');
    img.src = kitDataUrl(kk, n);
    img.height = 96;
    img.className = 'kit';
    kitBox.appendChild(img);
  }
  place();
  draw();
  drawAtlas();
  return {
    shirt: [kits.outfield[0].shirt, kits.outfield[1].shirt],
    keeper: [kits.keeper[0].shirt, kits.keeper[1].shirt],
    number: [kits.outfield[0].number, kits.outfield[1].number],
  };
}

function draw(): void {
  renderer.setScissorTest(true);
  renderer.setViewport(0, H * 0.5, W, H * 0.5);
  renderer.setScissor(0, H * 0.5, W, H * 0.5);
  renderer.setClearColor(0x2b2f3a);
  renderer.clear();
  renderer.render(sceneClose, camClose);
  renderer.setViewport(0, 0, W / 2, H * 0.4);
  renderer.setScissor(0, 0, W / 2, H * 0.4);
  renderer.setClearColor(0x4a9440);
  renderer.clear();
  renderer.render(sceneFar, camFar);
  const gy = H * 0.4 + 4, gh = H * 0.1 - 8;
  renderer.setViewport(0, gy, W / 2, gh);
  renderer.setScissor(0, gy, W / 2, gh);
  renderer.setScissorTest(true);
  renderer.setClearColor(0x07070d);
  renderer.clear();
  glyphCam.right = 6 * 0.3; glyphCam.top = (6 * 0.3 * gh) / (W / 2); glyphCam.updateProjectionMatrix();
  renderer.render(glyphScene, glyphCam);
  for (let i = 0; i < 6; i++) {
    const cx = ((0.15 + i * 0.3) / (6 * 0.3)) * (W / 2);
    const cy = H - (gy + (0.125 / glyphCam.top) * gh);
    probePts[`g${i}`] = [Math.round(cx), Math.round(cy)];
  }
  renderer.setScissorTest(false);
  // Far probe points: project the first torso of each line.
  for (const [name, i] of [['far0', 0], ['far1', 2]] as [string, number][]) {
    far.getMatrixAt(i, m4);
    const p = new Vector3(m4.elements[12]!, 0.3, m4.elements[14]!).project(camFar);
    probePts[name] = [Math.round(((p.x + 1) / 2) * (W / 2)), Math.round(H - ((p.y + 1) / 2) * (H * 0.4))];
  }
}

// Atlas preview and crests (DOM, bottom right).
const side = document.createElement('div');
side.style.cssText = `position:absolute;left:${W / 2 + 10}px;top:${H * 0.5 + 10}px;width:${W / 2 - 20}px;display:flex;gap:10px`;
document.body.appendChild(side);
const atlasCanvas = document.createElement('canvas');
atlasCanvas.width = 1024; atlasCanvas.height = 1024;
atlasCanvas.style.cssText = 'width:300px;height:300px;image-rendering:auto;background:repeating-conic-gradient(#555 0 25%,#333 0 50%) 0 0/16px 16px';
side.appendChild(atlasCanvas);
const kitBox = document.createElement('div');
kitBox.style.cssText = 'position:absolute;left:0;top:-104px;display:flex;gap:10px';
side.style.position = 'absolute';
side.appendChild(kitBox);
const crestBox = document.createElement('div');
crestBox.style.cssText = 'display:grid;grid-template-columns:repeat(5,44px);gap:6px;align-content:start';
side.appendChild(crestBox);
for (const c of CLUBS) {
  const img = document.createElement('img');
  img.src = crestDataUrl(c);
  img.width = 44; img.height = 44;
  img.alt = c.code;
  img.className = 'crest';
  crestBox.appendChild(img);
}

function drawAtlas(): void {
  const g = atlasCanvas.getContext('2d')!;
  const img = kitSet.atlas.image;
  const px = new Uint8ClampedArray(img.data.length);
  px.set(img.data);
  g.putImageData(new ImageData(px, img.w, img.h), 0, 0);
}

const gl = renderer.getContext();
window.__gfx08 = {
  ready: true,
  show,
  points: () => ({ ...probePts }),
  pixels(x, y, w, h) {
    const out = new Uint8Array(w * h * 4);
    const x0 = Math.round(x - w / 2), y0 = Math.round(y - h / 2);
    gl.readPixels(x0, H - y0 - h, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    const rows: number[] = [];
    for (let r = h - 1; r >= 0; r--) for (let i = 0; i < w * 4; i++) rows.push(out[r * w * 4 + i]!);
    return rows;
  },
  glError: () => gl.getError(),
  crestsLoaded: () => Array.from(document.querySelectorAll<HTMLImageElement>('img.crest')).filter((i) => i.complete && i.naturalWidth > 0).length,
  kitsLoaded: () => Array.from(document.querySelectorAll<HTMLImageElement>('img.kit')).filter((i) => i.complete && i.naturalWidth > 0).length,
};
// Keep resolveKits in the bundle for console experiments.
(window as unknown as { __gfx08Resolve?: typeof resolveKits }).__gfx08Resolve = resolveKits;
