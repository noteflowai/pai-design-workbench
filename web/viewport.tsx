import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

export type Ray = { origin: number[]; target: number[]; hit: number[] | null; firstHit: string | null; visible: boolean };
export type Stage = { index: number; label: string; url: string; objects: string[] };
export interface ViewportModel {
  key: string; which: "baseline" | "candidate"; stages: Stage[]; finalUrl?: string; ray?: Ray;
  render?: { sample: number; samples: number }; running: boolean; title: string;
}
type View = "persp" | "top" | "front" | "right" | "camera";
const VIEWS: { id: View; label: string; key: string }[] = [
  { id: "persp", label: "透视", key: "5" }, { id: "top", label: "顶视", key: "7" }, { id: "front", label: "前视", key: "1" },
  { id: "right", label: "右视", key: "3" }, { id: "camera", label: "检查相机", key: "0" },
];
const vec = (v: number[]) => new THREE.Vector3(v[0], v[1], v[2]);
/** GLTFLoader sanitizes node names; the original Blender object name is kept in userData. */
const nativeName = (o: THREE.Object3D) => String(o.userData.name ?? o.parent?.userData.name ?? o.name ?? "object");
function webglAvailable() {
  try { const c = document.createElement("canvas"); return Boolean(c.getContext("webgl2") ?? c.getContext("webgl")); } catch { return false; }
}

interface Runtime {
  renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls;
  root: THREE.Group; overlay: THREE.Group; grid: THREE.GridHelper; axes: THREE.AxesHelper; frame: number;
  animations: { start: number; duration: number; apply: (t: number) => void }[]; loader: GLTFLoader; known: Set<string>;
  /** Render on demand: only when the camera moves, an animation runs or the scene changed. */
  dirty: boolean;
}

/** Professional viewport over native Blender GLB snapshots. Presentation only; evidence stays in digests. */
export default function Viewport({ model }: { model?: ViewportModel }) {
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<Runtime>(undefined);
  const [webgl, setWebgl] = useState<"pending" | "ok" | "unavailable">("pending");
  const [objects, setObjects] = useState<{ name: string; visible: boolean; size: [number, number, number] }[]>([]);
  const [selected, setSelected] = useState<string>();
  const [scrub, setScrub] = useState<number>();
  const [view, setView] = useState<View>("persp");
  const [wire, setWire] = useState(false);
  const [xray, setXray] = useState(false);
  const [showGrid, setShowGrid] = useState(true);
  const [showRay, setShowRay] = useState(true);
  const [loaded, setLoaded] = useState("");

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    if (!webglAvailable()) { setWebgl("unavailable"); return; }
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.setAttribute("aria-label", "三维视口：拖动旋转，滚轮缩放，右键平移");
    renderer.domElement.tabIndex = 0;
    element.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1a20);
    scene.fog = new THREE.Fog(0x0d1a20, 14, 32);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 200);
    camera.position.set(6.5, 5.2, 7.5);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.target.set(0, 0.6, 0);
    controls.addEventListener("change", () => { if (runtime.current) runtime.current.dirty = true; });
    scene.add(new THREE.HemisphereLight(0xdcefff, 0x1b2a2e, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(4, 8, 5); key.castShadow = true; key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004; key.shadow.normalBias = 0.03;
    Object.assign(key.shadow.camera, { left: -6, right: 6, top: 6, bottom: -6 });
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fe3c1, 0.8); rim.position.set(-6, 3, -4); scene.add(rim);
    const grid = new THREE.GridHelper(12, 24, 0x3f6f68, 0x1f3a3c);
    (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = 0.55;
    scene.add(grid);
    const axes = new THREE.AxesHelper(0.6); axes.position.set(-2.4, 0.01, 1.9); scene.add(axes);
    const root = new THREE.Group(), overlay = new THREE.Group();
    scene.add(root, overlay);
    const r: Runtime = { renderer, scene, camera, controls, root, overlay, grid, axes, frame: 0, animations: [], loader: new GLTFLoader(), known: new Set(), dirty: true };
    runtime.current = r;
    const resize = () => {
      const w = element.clientWidth, h = element.clientHeight;
      renderer.setSize(w, h, false); camera.aspect = w / Math.max(h, 1); camera.updateProjectionMatrix(); r.dirty = true;
    };
    const observer = new ResizeObserver(resize); observer.observe(element); resize();
    const tick = (now: number) => {
      r.frame = requestAnimationFrame(tick);
      const animating = r.animations.length > 0;
      r.animations = r.animations.filter(a => { const t = Math.min(1, (now - a.start) / a.duration); a.apply(t); return t < 1; });
      const moved = controls.update();
      if (animating || moved || r.dirty) { renderer.render(scene, camera); r.dirty = false; }
    };
    r.frame = requestAnimationFrame(tick);
    setWebgl("ok");
    return () => {
      cancelAnimationFrame(r.frame); observer.disconnect(); controls.dispose(); renderer.dispose();
      renderer.domElement.remove(); runtime.current = undefined;
    };
  }, []);

  const stages = model?.stages ?? [];
  const activeIndex = scrub !== undefined && scrub < stages.length ? scrub : undefined;
  const url = activeIndex !== undefined ? stages[activeIndex].url : model?.finalUrl ?? stages.at(-1)?.url;
  useEffect(() => { setScrub(undefined); runtime.current?.known.clear(); }, [model?.key, model?.which]);

  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    if (!url) { r.root.clear(); r.known.clear(); r.dirty = true; setObjects([]); setSelected(undefined); setLoaded(""); return; }
    let cancelled = false;
    r.loader.load(url, gltf => {
      if (cancelled) return;
      r.root.clear();
      const meshes: THREE.Mesh[] = [];
      gltf.scene.traverse(o => { if ((o as THREE.Mesh).isMesh) { const m = o as THREE.Mesh; m.castShadow = true; m.receiveShadow = true; meshes.push(m); } });
      r.root.add(gltf.scene);
      const now = performance.now();
      const list = meshes.map(m => {
        const name = nativeName(m);
        const size = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3());
        if (!r.known.has(name)) {
          // Newly produced native geometry grows in with a short glow: the "live build" effect.
          const material = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial;
          const scale = m.scale.clone(), glow = material.emissive?.clone();
          m.scale.setScalar(0.001);
          r.animations.push({ start: now, duration: 650, apply: t => {
            const e = 1 - Math.pow(1 - t, 3);
            m.scale.set(scale.x * e, scale.y * e, scale.z * e);
            if (material.emissive && glow) material.emissive.setRGB(glow.r + (1 - t) * 0.25, glow.g + (1 - t) * 0.55, glow.b + (1 - t) * 0.45);
          } });
          r.known.add(name);
        }
        return { name, visible: true, size: [size.x, size.y, size.z] as [number, number, number] };
      });
      r.dirty = true; setObjects(list); setLoaded(url);
    }, undefined, () => { if (!cancelled) setLoaded(`error:${url}`); });
    return () => { cancelled = true; };
  }, [url]);

  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    r.root.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const name = nativeName(m);
      const item = objects.find(x => x.name === name);
      m.visible = item?.visible ?? true;
      for (const material of Array.isArray(m.material) ? m.material : [m.material]) {
        const standard = material as THREE.MeshStandardMaterial;
        standard.wireframe = wire;
        standard.transparent = xray; standard.opacity = xray ? 0.32 : 1; standard.depthWrite = !xray;
        if (standard.emissive && selected !== undefined) standard.emissiveIntensity = name === selected ? 1 : 0;
        if (standard.emissive && name === selected) standard.emissive.setRGB(0.1, 0.35, 0.3);
        else if (standard.emissive && selected !== undefined) standard.emissive.setRGB(0, 0, 0);
      }
    });
    r.grid.visible = showGrid; r.axes.visible = showGrid; r.dirty = true;
  }, [objects, wire, xray, selected, showGrid, loaded]);

  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    r.overlay.clear(); r.dirty = true;
    const ray = model?.ray;
    if (!ray || !showRay) return;
    const origin = vec(ray.origin), end = ray.hit ? vec(ray.hit) : vec(ray.target);
    const color = ray.visible ? 0x5ce0a8 : 0xff7a45;
    const geometry = new THREE.BufferGeometry().setFromPoints([origin, origin.clone()]);
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color }));
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshBasicMaterial({ color }));
    const lens = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.34, 4), new THREE.MeshBasicMaterial({ color: 0xe8f1f0, wireframe: true }));
    lens.position.copy(origin); lens.lookAt(end); lens.rotateX(Math.PI / 2);
    dot.position.copy(end); dot.scale.setScalar(0.001);
    r.overlay.add(line, dot, lens);
    if (!ray.visible) {
      const intended = new THREE.Line(new THREE.BufferGeometry().setFromPoints([end, vec(ray.target)]),
        new THREE.LineDashedMaterial({ color: 0xffc27a, dashSize: 0.12, gapSize: 0.08 }));
      intended.computeLineDistances(); r.overlay.add(intended);
    }
    r.animations.push({ start: performance.now(), duration: 700, apply: t => {
      const p = origin.clone().lerp(end, 1 - Math.pow(1 - t, 2));
      geometry.setFromPoints([origin, p]); dot.scale.setScalar(Math.max(0.001, t));
    } });
  }, [model?.ray, showRay, model?.key]);

  useEffect(() => {
    const r = runtime.current;
    if (!r) return;
    const target = new THREE.Vector3(0, 0.6, 0), from = r.camera.position.clone(), fromTarget = r.controls.target.clone();
    const positions: Record<View, THREE.Vector3> = {
      persp: new THREE.Vector3(6.5, 5.2, 7.5), top: new THREE.Vector3(0, 11, 0.001), front: new THREE.Vector3(0, 1.2, 8.5),
      right: new THREE.Vector3(8.5, 1.2, 0), camera: model?.ray ? vec(model.ray.origin) : new THREE.Vector3(3.6, 3.4, 4.8),
    };
    const to = positions[view], toTarget = view === "camera" && model?.ray ? vec(model.ray.target) : target;
    r.animations.push({ start: performance.now(), duration: 520, apply: t => {
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      r.camera.position.lerpVectors(from, to, e); r.controls.target.lerpVectors(fromTarget, toTarget, e);
    } });
  }, [view]);

  useEffect(() => {
    const listener = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (VIEWS.some(v => v.id === detail)) setView(detail as View);
      if (detail === "wire") setWire(w => !w);
      if (detail === "xray") setXray(x => !x);
    };
    window.addEventListener("pai-view", listener);
    return () => window.removeEventListener("pai-view", listener);
  }, []);

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const v = VIEWS.find(x => x.key === e.key);
    if (v) { setView(v.id); e.preventDefault(); }
    if (e.key.toLowerCase() === "z" && e.altKey) { setXray(x => !x); e.preventDefault(); }
    else if (e.key.toLowerCase() === "z") setWire(w => !w);
    if (e.key.toLowerCase() === "f") setView("persp");
  };
  const footprint = objects.find(o => o.name === "Workcell footprint");
  const inspected = objects.find(o => o.name === selected);
  const ray = model?.ray;
  return <div className="viewport" onKeyDown={onKey} data-webgl={webgl} data-objects={objects.length}
    data-stage={activeIndex !== undefined ? stages[activeIndex].index : stages.length} data-ray={ray ? (ray.visible ? "target" : "blocked") : "none"}>
    <div className="viewport-canvas" ref={host}>
      {webgl === "unavailable" && <div className="viewport-fallback">此浏览器未启用 WebGL；原生渲染图与下载文件不受影响。</div>}
      {webgl === "ok" && !url && <div className="viewport-empty"><strong>实时原生视口</strong><span>在左侧对话或确认计划后，Blender 每完成一个构建阶段，这里即时出现对应的原生几何。</span></div>}
      <div className="viewport-hud top-left">
        <span className={`live-dot ${model?.running ? "on" : ""}`} />{model?.running ? "LIVE · Blender 原生构建中" : model ? model.title : "等待原生任务"}
        {model && <small>{model.which === "baseline" ? "基准布局" : "候选布局"} · {activeIndex !== undefined ? `阶段 ${stages[activeIndex].index}/${stages.length}` : model.finalUrl ? "最终 GLB（摘要已核验）" : `阶段 ${stages.length}`}</small>}
      </div>
      <div className="viewport-hud top-right" role="toolbar" aria-label="视图预设">
        {VIEWS.map(v => <button key={v.id} type="button" className={view === v.id ? "active" : ""} aria-pressed={view === v.id} title={`快捷键 ${v.key}`} onClick={() => setView(v.id)}>{v.label}</button>)}
      </div>
      {ray && <div className={`viewport-hud bottom-left ray-badge ${ray.visible ? "ok" : "blocked"}`}>原生射线首个命中：{ray.firstHit === "Target" ? "目标" : ray.firstHit ?? "无"}{ray.visible ? " · 可见" : " · 被遮挡"}</div>}
      {model?.render && <div className="viewport-hud bottom-right render-progress" role="progressbar" aria-label="Cycles 渲染采样" aria-valuemin={0} aria-valuemax={model.render.samples} aria-valuenow={model.render.sample}>
        <span>Cycles {model.render.sample}/{model.render.samples}</span><i style={{ width: `${(model.render.sample / model.render.samples) * 100}%` }} /></div>}
    </div>
    <div className="viewport-side">
      <div className="outliner"><strong>大纲 · Outliner</strong>
        {objects.length === 0 ? <p>尚无原生几何</p> : <ul>{objects.map(o => <li key={o.name} className={selected === o.name ? "selected" : ""}>
          <label className="check"><input type="checkbox" checked={o.visible} aria-label={`显示 ${o.name}`} onChange={e => setObjects(list => list.map(x => x.name === o.name ? { ...x, visible: e.target.checked } : x))} /></label>
          <button type="button" onClick={() => setSelected(s => s === o.name ? undefined : o.name)}>{o.name}</button></li>)}</ul>}
      </div>
      <div className="inspector"><strong>检查器</strong>
        {inspected ? <p>{inspected.name}<br />{inspected.size.map(n => n.toFixed(2)).join(" × ")} m（包围盒）</p>
          : footprint ? <p>占地包围盒 {footprint.size[0].toFixed(2)} × {footprint.size[2].toFixed(2)} m</p> : <p>选择对象查看尺寸</p>}
        <div className="toggles">
          <label className="check"><input type="checkbox" checked={wire} onChange={e => setWire(e.target.checked)} />线框 (Z)</label>
          <label className="check"><input type="checkbox" checked={xray} onChange={e => setXray(e.target.checked)} />X 光透视 (Alt+Z)</label>
          <label className="check"><input type="checkbox" checked={showGrid} onChange={e => setShowGrid(e.target.checked)} />网格与坐标轴</label>
          <label className="check"><input type="checkbox" checked={showRay} onChange={e => setShowRay(e.target.checked)} />射线叠加</label>
        </div>
      </div>
    </div>
    {stages.length > 0 && <div className="scrubber"><span>构建阶段</span>
      <input type="range" min={0} max={stages.length} value={activeIndex ?? stages.length} aria-label="构建阶段时间轴"
        onChange={e => { const v = Number(e.target.value); setScrub(v >= stages.length ? undefined : v); runtime.current?.known.clear(); }} />
      <small>{activeIndex !== undefined ? `${stages[activeIndex].index}. ${stages[activeIndex].label}` : model?.finalUrl ? "最终原生场景" : `${stages.at(-1)?.index}. ${stages.at(-1)?.label}`}</small></div>}
  </div>;
}
