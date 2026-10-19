import { useEffect, useRef, useState } from "react";
import { ArrowsOut, CircleNotch, Cube, Eye, EyeSlash, Info, PersonSimpleWalk, Scissors, WarningCircle } from "@phosphor-icons/react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

const LAYER_LABELS = { buildings: "建筑", site: "场地", landscape: "景观", traffic: "交通", redline: "红线" };

function layerLabel(role) {
  return LAYER_LABELS[role] || role;
}

function triangleCount(object) {
  const geometry = object.geometry;
  if (!geometry) return 0;
  const count = geometry.index ? geometry.index.count : geometry.attributes?.position?.count || 0;
  return count / 3;
}

function regionOf(object) {
  let current = object;
  while (current) {
    if (current.userData?.regionId) return current.userData.regionId;
    current = current.parent;
  }
  return null;
}

function analyze(gltf) {
  const sceneExtras = gltf.scenes?.[0]?.extras || gltf.parser?.json?.scenes?.[0]?.extras || {};
  const layers = new Set();
  const regionNodes = new Map();
  const triangleTotals = new Map();
  let meshes = 0;
  let triangles = 0;

  gltf.scene.traverse((object) => {
    if (object.userData?.layerRole) layers.add(object.userData.layerRole);
    if (object.userData?.regionId && !regionNodes.has(object.userData.regionId)) {
      regionNodes.set(object.userData.regionId, { id: object.userData.regionId, node: object, label: object.userData.regionLabel || object.userData.regionId });
    }
    if (!object.isMesh) return;
    meshes += 1;
    const count = triangleCount(object);
    triangles += count;
    const regionId = regionOf(object);
    if (regionId) triangleTotals.set(regionId, (triangleTotals.get(regionId) || 0) + count);
  });

  const regions = [...regionNodes.values()]
    .map((region) => ({ ...region, triangles: Math.round(triangleTotals.get(region.id) || 0), box: new THREE.Box3().setFromObject(region.node) }))
    .sort((left, right) => right.triangles - left.triangles);

  return {
    status: sceneExtras.status || null,
    schemaVersion: sceneExtras.schemaVersion || null,
    statistics: sceneExtras.statistics || null,
    layers: [...layers].sort(),
    regions,
    regionNodes,
    bounds: new THREE.Box3().setFromObject(gltf.scene),
    meshes,
    triangles: Math.round(triangles),
  };
}

function disposeScene(scene) {
  scene.traverse((object) => {
    if (!object.isMesh && !object.isLine && !object.isPoints) return;
    object.geometry?.dispose?.();
    for (const material of [object.material].flat()) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value?.isTexture) value.dispose();
      }
      material.dispose?.();
    }
  });
}

function formatMeters(value) {
  return `${Math.round(value)} m`;
}

export default function GlbPreview({ document, revision }) {
  const hostRef = useRef(null);
  const viewRef = useRef(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [info, setInfo] = useState(null);
  const [regionId, setRegionId] = useState("all");
  const [hiddenLayers, setHiddenLayers] = useState(() => new Set());
  const [walking, setWalking] = useState(false);
  const [section, setSection] = useState(null);
  const wasWalking = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    let frame = 0;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeef0f1);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.className = "glb-canvas";
    host.appendChild(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    scene.environment = pmrem.fromScene(room, 0.04).texture;
    room.dispose?.();
    pmrem.dispose();

    scene.add(new THREE.HemisphereLight(0xffffff, 0x6c6e70, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(1, 1.5, 0.9);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.45);
    fill.position.set(-1, 0.5, -0.9);
    scene.add(fill);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.maxPolarAngle = Math.PI * 0.495;

    const grid = new THREE.GridHelper(10, 20, 0xb7bab6, 0xd8dad6);
    grid.material.transparent = true;
    grid.material.opacity = 0.55;
    scene.add(grid);

    renderer.localClippingEnabled = true;
    const sectionPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), Number.POSITIVE_INFINITY);
    const materials = new Set();
    const originalSides = new Map();

    const view = { scene, camera, renderer, controls, grid, regionNodes: new Map(), boxes: new Map(), frameBox: null, materials, walking: false, keys: new Set(), look: null };
    viewRef.current = view;

    const eyeHeight = 1.7;
    view.enterWalk = () => {
      const direction = new THREE.Vector3();
      camera.getWorldDirection(direction);
      view.yaw = Math.atan2(-direction.x, -direction.z);
      // Level the horizon: entering from an overhead orbit would otherwise look at the ground.
      view.pitch = 0;
      // Drop the current viewpoint to eye height so entering keeps your bearings.
      camera.position.y = (view.groundY ?? 0) + eyeHeight;
      camera.rotation.set(view.pitch, view.yaw, 0, "YXZ");
      camera.near = 0.05;
      camera.far = Math.max(view.radius * 40, 500);
      camera.updateProjectionMatrix();
      controls.enabled = false;
      for (const material of materials) material.side = THREE.DoubleSide;
      view.walking = true;
    };
    view.exitWalk = () => {
      view.walking = false;
      view.keys.clear();
      controls.enabled = true;
      for (const material of materials) material.side = originalSides.get(material) ?? THREE.FrontSide;
      const forward = new THREE.Vector3();
      camera.getWorldDirection(forward);
      controls.target.copy(camera.position).add(forward.multiplyScalar(8));
      controls.update();
      camera.near = Math.max(view.radius / 5000, 0.01);
      camera.far = view.radius * 80;
      camera.updateProjectionMatrix();
    };
    view.setSection = (height) => {
      sectionPlane.constant = height ?? Number.POSITIVE_INFINITY;
      for (const material of materials) {
        material.clippingPlanes = height === null ? null : [sectionPlane];
        material.needsUpdate = true;
      }
    };

    const pressed = (event) => {
      if (!view.walking) return;
      const key = event.key.toLowerCase();
      if (["w", "a", "s", "d", "arrowup", "arrowdown", "arrowleft", "arrowright", "shift"].includes(key)) {
        event.preventDefault();
        view.keys.add(key);
      }
    };
    const released = (event) => view.keys.delete(event.key.toLowerCase());
    window.addEventListener("keydown", pressed);
    window.addEventListener("keyup", released);
    const onPointerDown = (event) => {
      if (!view.walking || event.button !== 0) return;
      view.look = { x: event.clientX, y: event.clientY };
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event) => {
      if (!view.look) return;
      const dx = event.clientX - view.look.x;
      const dy = event.clientY - view.look.y;
      view.look = { x: event.clientX, y: event.clientY };
      view.yaw -= dx * 0.0032;
      view.pitch = THREE.MathUtils.clamp(view.pitch - dy * 0.0032, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
      camera.rotation.set(view.pitch, view.yaw, 0, "YXZ");
    };
    const onPointerUp = (event) => {
      view.look = null;
      if (renderer.domElement.hasPointerCapture?.(event.pointerId)) renderer.domElement.releasePointerCapture(event.pointerId);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointerleave", onPointerUp);

    const resize = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    resize();

    view.frameBox = (box) => {
      if (box.isEmpty()) return;
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const radius = Math.max(size.x, size.y, size.z) / 2 || 1;
      const distance = radius / Math.tan((camera.fov * Math.PI) / 360) * 1.35;
      camera.near = Math.max(distance / 5000, 0.01);
      camera.far = distance * 80;
      camera.position.copy(center).add(new THREE.Vector3(distance * 0.58, distance * 0.62, distance * 0.72));
      camera.updateProjectionMatrix();
      controls.minDistance = radius * 0.05;
      controls.maxDistance = distance * 8;
      controls.target.copy(center);
      controls.update();
      const span = Math.max(size.x, size.z) * 2.2 || 10;
      grid.scale.setScalar(span / 10);
      grid.position.set(center.x, box.min.y, center.z);
      view.groundY = box.min.y;
      view.radius = radius;
    };

    const animate = () => {
      if (disposed) return;
      if (view.walking) {
        const speed = (view.keys.has("shift") ? 12 : 4) * 0.016;
        const forward = Number(view.keys.has("w") || view.keys.has("arrowup")) - Number(view.keys.has("s") || view.keys.has("arrowdown"));
        const strafe = Number(view.keys.has("d") || view.keys.has("arrowright")) - Number(view.keys.has("a") || view.keys.has("arrowleft"));
        if (forward || strafe) {
          const sin = Math.sin(view.yaw);
          const cos = Math.cos(view.yaw);
          camera.position.x += (-sin * forward + cos * strafe) * speed;
          camera.position.z += (-cos * forward - sin * strafe) * speed;
          camera.position.y = (view.groundY ?? 0) + eyeHeight;
        }
      } else {
        controls.update();
      }
      renderer.render(scene, camera);
      frame = requestAnimationFrame(animate);
    };

    setStatus("loading");
    setError("");
    setInfo(null);

    const loader = new GLTFLoader();
    loader.load(
      `${document.url}?v=${revision}`,
      (gltf) => {
        if (disposed) {
          disposeScene(gltf.scene);
          return;
        }
        scene.add(gltf.scene);
        const metadata = analyze(gltf);
        view.regionNodes = metadata.regionNodes;
        for (const region of metadata.regions) view.boxes.set(region.id, region.box);
        gltf.scene.traverse((object) => {
          if (!object.isMesh || !object.material) return;
          for (const material of [object.material].flat()) {
            if (!material) continue;
            if (!materials.has(material)) {
              materials.add(material);
              originalSides.set(material, material.side);
            }
          }
        });
        setInfo(metadata);
        const initial = metadata.regions[0]?.id || "all";
        setRegionId(initial);
        for (const [id, node] of metadata.regionNodes) node.visible = initial === "all" || id === initial;
        view.frameBox(initial === "all" ? new THREE.Box3().setFromObject(gltf.scene) : view.boxes.get(initial));
        setStatus("ready");
        animate();
      },
      undefined,
      () => {
        if (disposed) return;
        setStatus("error");
        setError("无法解析此 GLB 文件。请确认它是有效的 glTF 2.0 二进制模型。");
      },
    );

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("keydown", pressed);
      window.removeEventListener("keyup", released);
      controls.dispose();
      grid.geometry?.dispose();
      grid.material?.dispose();
      disposeScene(scene);
      scene.environment?.dispose?.();
      renderer.dispose();
      renderer.forceContextLoss?.();
      renderer.domElement.remove();
      viewRef.current = null;
    };
  }, [document.url, revision]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !info) return;
    for (const [id, node] of view.regionNodes) node.visible = regionId === "all" || id === regionId;
    if (regionId !== "all") {
      const box = view.boxes.get(regionId);
      if (box) view.frameBox?.(box);
    }
  }, [regionId, info]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    for (const role of info?.layers || []) {
      const visible = !hiddenLayers.has(role);
      view.scene.traverse((object) => {
        if (object.userData?.layerRole === role) object.visible = visible;
      });
    }
  }, [hiddenLayers, info]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || status !== "ready") return;
    if (walking && !wasWalking.current) view.enterWalk?.();
    if (!walking && wasWalking.current) view.exitWalk?.();
    wasWalking.current = walking;
  }, [walking, status]);

  useEffect(() => {
    viewRef.current?.setSection?.(section);
  }, [section, status]);

  useEffect(() => {
    if (!walking) return undefined;
    const onKey = (event) => { if (event.key === "Escape") setWalking(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [walking]);

  useEffect(() => { setWalking(false); }, [regionId]);

  const toggleLayer = (role) => {
    setHiddenLayers((current) => {
      const next = new Set(current);
      if (next.has(role)) next.delete(role);
      else next.add(role);
      return next;
    });
  };

  const frameRegion = () => {
    const view = viewRef.current;
    if (!view) return;
    const box = regionId === "all" ? null : view.boxes.get(regionId);
    if (box) view.frameBox?.(box);
    else if (view.scene) view.frameBox?.(new THREE.Box3().setFromObject(view.scene));
  };

  const regions = info?.regions || [];
  const selected = regions.find((region) => region.id === regionId);
  const selectedSpan = selected ? Math.max(selected.box.getSize(new THREE.Vector3()).x, selected.box.getSize(new THREE.Vector3()).z) : 0;
  const activeBox = selected?.box || info?.bounds || null;
  const sectionRange = activeBox ? [Number((activeBox.min.y + 0.2).toFixed(1)), Number(activeBox.max.y.toFixed(1))] : [0, 10];
  const defaultSection = Number((sectionRange[0] + (sectionRange[1] - sectionRange[0]) * 0.72).toFixed(1));

  return (
    <div className="model-preview">
      <div className="model-toolbar">
        {regions.length > 1 && (
          <label className="model-region-control">
            <span>区域</span>
            <select value={regionId} onChange={(event) => setRegionId(event.target.value)} aria-label="建模区域">
              <option value="all">全部区域（{regions.length}）</option>
              {regions.map((region) => (
                <option key={region.id} value={region.id}>{region.label} · {region.triangles.toLocaleString()} 面</option>
              ))}
            </select>
          </label>
        )}
        <div className="model-layer-chips" role="group" aria-label="模型图层">
          {(info?.layers || []).map((role) => (
            <button
              key={role}
              type="button"
              className={hiddenLayers.has(role) ? "is-off" : "is-on"}
              onClick={() => toggleLayer(role)}
              title={`${hiddenLayers.has(role) ? "显示" : "隐藏"}${layerLabel(role)}图层`}
              aria-pressed={!hiddenLayers.has(role)}
            >
              {hiddenLayers.has(role) ? <EyeSlash size={13} /> : <Eye size={13} />}
              {layerLabel(role)}
            </button>
          ))}
        </div>
        <button type="button" className={`model-frame-button ${walking ? "is-active" : ""}`} onClick={() => setWalking((value) => !value)} disabled={status !== "ready"} title={walking ? "退出室内漫游（Esc）" : "进入室内漫游"}>
          <PersonSimpleWalk size={14} />{walking ? "退出漫游" : "室内漫游"}
        </button>
        <button type="button" className={`model-frame-button ${section !== null ? "is-active" : ""}`} onClick={() => setSection((value) => value === null ? defaultSection : null)} disabled={status !== "ready"} title="按高度剖切，查看内部平面">
          <Scissors size={14} />剖切
        </button>
        {section !== null && (
          <label className="model-section-control">
            <input type="range" min={sectionRange[0]} max={sectionRange[1]} step={0.1} value={section} onChange={(event) => setSection(Number(event.target.value))} aria-label="剖切高度" />
            <span>{section.toFixed(1)} m</span>
          </label>
        )}
        <button type="button" className="model-frame-button" onClick={frameRegion} disabled={status !== "ready"} title="恢复默认视角">
          <ArrowsOut size={14} />适应视角
        </button>
      </div>
      <div className="model-stage">
        <div ref={hostRef} className="model-canvas-host" aria-label={`三维预览 ${document.name}`} />
        {walking && (
          <div className="model-walk-hint">WASD 移动 · Shift 加速 · 拖动鼠标转向 · Esc 退出</div>
        )}
        {status === "loading" && (
          <div className="model-overlay"><CircleNotch size={18} className="spin" /><span>正在加载三维模型</span></div>
        )}
        {status === "error" && (
          <div className="model-overlay is-error" role="alert">
            <WarningCircle size={19} weight="fill" />
            <strong>无法显示模型</strong>
            <p>{error}</p>
          </div>
        )}
      </div>
      <div className="model-status">
        {info ? (
          <>
            <span><Cube size={13} />{info.meshes.toLocaleString()} 个网格 · {info.triangles.toLocaleString()} 三角面</span>
            {selected && <span title="当前区域包围盒">区域 {formatMeters(selectedSpan)} 见方</span>}
            {info.status && <span className={`model-badge ${info.status === "ready" ? "is-ready" : "is-review"}`}>{info.status}</span>}
            {info.schemaVersion && <span>语义 {info.schemaVersion}</span>}
            {info.statistics?.assumptionCount ? <span className="model-badge is-review">{info.statistics.assumptionCount} 条假设</span> : null}
            {walking ? <span className="model-badge is-review">方案体块内部为空壳，无楼板与隔墙</span> : null}
          </>
        ) : <span><Info size={13} />拖拽旋转 · 滚轮缩放 · 右键平移</span>}
      </div>
    </div>
  );
}
