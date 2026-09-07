import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { World } from './runtime';
import type { CameraState, ObjectPose, Quat, Vec3 } from './types';
import { createOrientationGizmo } from './OrientationGizmo';
import { aroundPivot, transformCamera, transformPoses } from './editor-transform';

export function Viewer({ world }: { world: World }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = host.current!,
      scene = new THREE.Scene();
    const updateTheme = () => {
      scene.background = new THREE.Color(
        getComputedStyle(document.documentElement).getPropertyValue('--ctp-mantle').trim() ||
          '#181825',
      );
    };
    updateTheme();
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 1000),
      recordCamera = camera.clone(),
      helperCamera = camera.clone();
    for (const c of [camera, recordCamera, helperCamera]) c.up.set(0, 0, 1);
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    container.append(renderer.domElement);
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', '3D viewport');
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    let syncing = false,
      revision = -1;
    const setCamera = (c: THREE.PerspectiveCamera, state: CameraState) => {
      c.position.fromArray(state.position);
      c.lookAt(new THREE.Vector3().fromArray(state.target));
      c.updateMatrixWorld();
    };
    const restoreView = () => {
      const state = world.view.mode === 'camera' ? world.currentFrame.camera : world.view.camera;
      setCamera(camera, state);
      controls.target.fromArray(state.target);
      controls.update();
    };
    restoreView();
    scene.add(new THREE.HemisphereLight(0xc6d3e8, 0x525057, 2));
    const light = new THREE.DirectionalLight(0xffefd9, 2.5);
    light.position.set(-1, -2, 5);
    scene.add(light);
    const grid = new THREE.GridHelper(20, 100, 0x536475, 0x303946);
    grid.rotation.x = Math.PI / 2;
    grid.material.transparent = true;
    grid.material.opacity = 0.28;
    grid.material.depthWrite = false;
    scene.add(grid);
    const meshes: THREE.Mesh[] = [];
    const m = world.model;
    for (let i = 0; i < m.ngeom; i++) {
      const [x, y, z] = Array.from(m.geom_size as ArrayLike<number>).slice(i * 3, i * 3 + 3);
      const type = m.geom_type[i];
      let geometry: THREE.BufferGeometry;
      if (type === 0) geometry = new THREE.PlaneGeometry(x ? x * 2 : 6, y ? y * 2 : 6);
      else if (type === 2) geometry = new THREE.SphereGeometry(x, 32, 20);
      else if (type === 3) {
        geometry = new THREE.CapsuleGeometry(x, y * 2, 8, 24);
        geometry.rotateX(Math.PI / 2);
      } else if (type === 4) {
        geometry = new THREE.SphereGeometry(1, 32, 20);
        geometry.scale(x, y, z);
      } else if (type === 5) {
        geometry = new THREE.CylinderGeometry(x, x, y * 2, 32);
        geometry.rotateX(Math.PI / 2);
      } else if (type === 7) {
        const meshId = m.geom_dataid[i],
          start = m.mesh_vertadr[meshId],
          count = m.mesh_vertnum[meshId],
          faceStart = m.mesh_faceadr[meshId],
          faceCount = m.mesh_facenum[meshId];
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(
            (m.mesh_vert as Float32Array).slice(start * 3, (start + count) * 3),
            3,
          ),
        );
        geometry.setIndex(
          new THREE.BufferAttribute(
            new Uint32Array(
              (m.mesh_face as Int32Array).subarray(faceStart * 3, (faceStart + faceCount) * 3),
            ),
            1,
          ),
        );
        geometry.computeVertexNormals();
      } else geometry = new THREE.BoxGeometry(x * 2, y * 2, z * 2);
      const rgba = Array.from(m.geom_rgba as ArrayLike<number>).slice(i * 4, i * 4 + 4);
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(rgba[0], rgba[1], rgba[2]),
        roughness: 0.7,
        transparent: rgba[3] < 1,
        opacity: rgba[3],
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = rgba[3] === 1;
      mesh.receiveShadow = true;
      const outline = new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry, 25),
        new THREE.LineBasicMaterial({ color: 0xf2b26d }),
      );
      outline.visible = false;
      mesh.add(outline);
      mesh.userData.body = world.name(m.geom_bodyid[i]);
      scene.add(mesh);
      meshes.push(mesh);
    }

    const helper = new THREE.CameraHelper(helperCamera);
    scene.add(helper);
    const cameraBody = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.1, 0.08),
      new THREE.MeshBasicMaterial({ color: 0x89b4fa, wireframe: true }),
    );
    scene.add(cameraBody);
    const cameraHit = new THREE.Mesh(
      new THREE.BoxGeometry(0.22, 0.18, 0.16),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    scene.add(cameraHit);
    const proxy = new THREE.Object3D();
    scene.add(proxy);
    const gizmo = new TransformControls(camera, renderer.domElement);
    gizmo.setSpace('world');
    scene.add(gizmo.getHelper());
    type Preview = {
      kind: 'modal' | 'gizmo';
      mode: 'translate' | 'rotate';
      poses: ObjectPose[];
      camera?: CameraState;
      pivot: THREE.Vector3;
      delta: THREE.Matrix4;
      start: THREE.Vector2;
      startInverse: THREE.Matrix4;
      axis: 'X' | 'Y' | 'Z' | null;
      angle: number | null;
    };
    let preview: Preview | null = null,
      cancelling = false,
      suppressUp = false;
    const lastPointer = new THREE.Vector2(),
      down = new THREE.Vector2(),
      ray = new THREE.Raycaster();
    const fail = (e: unknown) => {
      world.error = e instanceof Error ? e.message : String(e);
      world.notify();
    };
    const ndc = (point: THREE.Vector2) => {
      const r = renderer.domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((point.x - r.left) / r.width) * 2 - 1,
        1 - ((point.y - r.top) / r.height) * 2,
      );
    };
    const screen = (point: THREE.Vector3) => {
      const r = renderer.domElement.getBoundingClientRect(),
        p = point.clone().project(camera);
      return new THREE.Vector2(
        r.left + ((p.x + 1) * r.width) / 2,
        r.top + ((1 - p.y) * r.height) / 2,
      );
    };
    const chosen = () =>
      world.selected
        .filter((id) => !world.view.hidden.has(id))
        .map((id) => world.object(id))
        .filter((o) => o.movable)
        .map((o) => ({ id: o.id, position: o.position as Vec3, quaternion: o.quaternion as Quat }));
    const begin = (kind: Preview['kind'], mode: Preview['mode']) => {
      if (world.busy || world.cursor !== null) return false;
      const poses = world.cameraSelected ? [] : chosen();
      if (!poses.length && !world.cameraSelected) {
        world.status = 'Select a movable object or camera';
        world.notify();
        return false;
      }
      if (world.cameraSelected && world.view.mode === 'camera') world.frameSelection();
      const c = world.cameraSelected ? structuredClone(world.camera) : undefined;
      const pivot = c
        ? new THREE.Vector3().fromArray(c.position)
        : poses
            .reduce(
              (sum, p) => sum.add(new THREE.Vector3().fromArray(p.position)),
              new THREE.Vector3(),
            )
            .divideScalar(poses.length);
      proxy.updateMatrixWorld();
      const rect = renderer.domElement.getBoundingClientRect();
      const start = lastPointer.lengthSq()
        ? lastPointer.clone()
        : new THREE.Vector2(rect.left + rect.width * 0.65, rect.top + rect.height * 0.5);
      preview = {
        kind,
        mode,
        poses,
        camera: c,
        pivot,
        delta: new THREE.Matrix4(),
        start,
        startInverse: proxy.matrixWorld.clone().invert(),
        axis: null,
        angle: null,
      };
      world.busy = true;
      world.status =
        (mode === 'translate' ? 'Move' : 'Rotate') +
        ' · X / Y / Z Axis · Enter Confirm · Esc Cancel';
      world.notify();
      controls.enabled = false;
      return true;
    };
    const finish = (cancel = false) => {
      if (!preview) return;
      const p = preview;
      preview = null;
      cancelling = true;
      if (cancel) gizmo.reset();
      gizmo.dragging = false;
      cancelling = false;
      world.busy = false;
      world.status = '';
      world.notify();
      if (cancel || p.delta.elements.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-10))
        return;
      const task = p.camera
        ? world.updateCamera(transformCamera(p.camera, p.delta))
        : world.editPoses(
            transformPoses(p.poses, p.delta),
            p.mode === 'translate' ? 'Move Objects' : 'Rotate Objects',
          );
      void task.catch(fail);
    };
    const fromProxy = () => {
      if (preview?.kind === 'gizmo') {
        proxy.updateMatrixWorld();
        preview.delta.multiplyMatrices(proxy.matrixWorld, preview.startInverse);
      }
    };
    gizmo.addEventListener('objectChange', fromProxy);
    gizmo.addEventListener('dragging-changed', (e) => {
      if (cancelling) return;
      if (e.value) {
        if (!begin('gizmo', world.display.gizmo)) {
          cancelling = true;
          gizmo.dragging = false;
          cancelling = false;
        }
      } else {
        fromProxy();
        finish();
        suppressUp = true;
      }
    });
    const modalMove = (point: THREE.Vector2) => {
      const p = preview;
      if (!p || p.kind !== 'modal') return;
      const axis = p.axis
        ? new THREE.Vector3(
            ...({ X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }[p.axis] as [number, number, number]),
          )
        : camera.getWorldDirection(new THREE.Vector3());
      if (p.mode === 'translate') {
        const delta = new THREE.Vector3();
        if (p.axis) {
          const origin = screen(p.pivot),
            end = screen(p.pivot.clone().add(axis)),
            direction = end.sub(origin),
            movement = point.clone().sub(p.start);
          const distance =
            direction.lengthSq() > 1
              ? movement.dot(direction) / direction.lengthSq()
              : (-movement.y * camera.position.distanceTo(p.pivot)) /
                renderer.domElement.clientHeight;
          delta.copy(axis).multiplyScalar(distance);
        } else {
          const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, p.pivot),
            a = new THREE.Vector3(),
            b = new THREE.Vector3();
          ray.setFromCamera(ndc(p.start), camera);
          const hitA = ray.ray.intersectPlane(plane, a);
          ray.setFromCamera(ndc(point), camera);
          const hitB = ray.ray.intersectPlane(plane, b);
          if (!hitA || !hitB) return;
          delta.subVectors(b, a);
        }
        p.delta.makeTranslation(delta.x, delta.y, delta.z);
      } else {
        const center = screen(p.pivot),
          initial = p.start.clone().sub(center),
          current = point.clone().sub(center);
        if (current.length() < 3) return;
        if (p.angle === null)
          p.angle =
            initial.length() > 3
              ? Math.atan2(-initial.y, initial.x)
              : Math.atan2(-current.y, current.x);
        const angle = Math.atan2(-current.y, current.x) - p.angle;
        p.delta.copy(aroundPivot(new THREE.Quaternion().setFromAxisAngle(axis, -angle), p.pivot));
      }
    };
    const onMove = (e: PointerEvent) => {
      if (preview?.kind === 'modal') {
        e.preventDefault();
        e.stopImmediatePropagation();
        modalMove(new THREE.Vector2(e.clientX, e.clientY));
      } else if (e.target === renderer.domElement) lastPointer.set(e.clientX, e.clientY);
    };
    const onModalDown = (e: PointerEvent) => {
      if (!preview) return;
      if (e.button === 2 || (preview.kind === 'modal' && e.button === 0)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        suppressUp = true;
        finish(e.button === 2);
      }
    };
    const onModalKey = (e: KeyboardEvent) => {
      if (!preview) return;
      if (e.isComposing) return;
      const key = e.key.toUpperCase();
      if (['ESCAPE', 'ENTER', 'X', 'Y', 'Z'].includes(key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (key === 'ESCAPE' || key === 'ENTER') {
          finish(key === 'ESCAPE');
          return;
        }
        if (preview.kind === 'modal') {
          preview.axis = preview.axis === key ? null : (key as Preview['axis']);
          world.status =
            (preview.mode === 'translate' ? 'Move' : 'Rotate') +
            (preview.axis ? ' · ' + preview.axis : ' · View') +
            ' · Enter Confirm · Esc Cancel';
          world.notify();
        }
      }
    };
    const cancel = () => finish(true);
    const interaction = {
      begin: (mode: 'translate' | 'rotate') => {
        renderer.domElement.focus();
        if (begin('modal', mode)) gizmo.detach();
      },
      cancel,
    };
    world.interaction = interaction;
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerdown', onModalDown, true);
    document.addEventListener('keydown', onModalKey, true);
    window.addEventListener('blur', cancel);
    const onVisibility = () => {
      if (document.hidden) cancel();
    };
    document.addEventListener('visibilitychange', onVisibility);
    const onNavigationStart = () => {
      if (syncing || preview || world.busy) return;
      if (world.view.mode === 'camera')
        world.setViewCamera({
          position: camera.position.toArray() as Vec3,
          target: controls.target.toArray() as Vec3,
        });
    };
    const saveView = () => {
      if (syncing || preview || world.busy) return;
      world.setViewCamera({
        position: camera.position.toArray() as Vec3,
        target: controls.target.toArray() as Vec3,
      });
    };
    controls.addEventListener('start', onNavigationStart);
    controls.addEventListener('end', saveView);
    const orientation = createOrientationGizmo(container, (direction) => {
      if (preview || world.busy) return;
      const distance = camera.position.distanceTo(controls.target);
      if (Math.abs(direction.z) === 1) direction.y = -1e-6;
      camera.position.copy(controls.target).addScaledVector(direction.normalize(), distance);
      camera.lookAt(controls.target);
      controls.update();
      saveView();
    });
    const onDown = (e: PointerEvent) => {
      down.set(e.clientX, e.clientY);
      renderer.domElement.focus();
    };
    const onUp = (e: PointerEvent) => {
      if (suppressUp) {
        suppressUp = false;
        return;
      }
      if (
        preview ||
        world.busy ||
        gizmo.axis ||
        e.button !== 0 ||
        Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4
      )
        return;
      ray.setFromCamera(ndc(new THREE.Vector2(e.clientX, e.clientY)), camera);
      const selectable = meshes.filter(
        (mesh) =>
          mesh.visible &&
          !world.view.locked.has(mesh.userData.body) &&
          world.episode.manifest.objects.some((o) => o.id === mesh.userData.body),
      );
      const hits = ray.intersectObjects(
        [...selectable, ...(helper.visible ? [cameraHit] : [])],
        false,
      );
      if (hits[0]?.object === cameraHit) {
        world.selectCamera();
        return;
      }
      const id = hits[0]?.object.userData.body;
      world.select(id ? [id] : [], e.shiftKey || e.metaKey || e.ctrlKey);
    };
    const context = (e: MouseEvent) => e.preventDefault();
    renderer.domElement.addEventListener('pointerdown', onDown);
    renderer.domElement.addEventListener('pointerup', onUp);
    renderer.domElement.addEventListener('contextmenu', context);
    const resize = new ResizeObserver(() => {
      const { width, height } = container.getBoundingClientRect();
      if (width < 1 || height < 1) return;
      renderer.setSize(width, height);
      for (const c of [camera, recordCamera, helperCamera]) {
        c.aspect = width / height;
        c.updateProjectionMatrix();
      }
    });
    resize.observe(container);
    const rotation = new THREE.Matrix4();
    const render = (live = false) => {
      if (revision !== world.revision) {
        syncing = true;
        if (!preview) restoreView();
        syncing = false;
        revision = world.revision;
      }
      const frame = live ? world.snapshot() : world.currentFrame,
        data = live ? world.data : world.viewedData();
      setCamera(recordCamera, frame.camera);
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i];
        mesh.position.fromArray(data.geom_xpos, i * 3);
        const r = data.geom_xmat,
          p = i * 9;
        mesh.quaternion.setFromRotationMatrix(
          rotation.set(
            r[p],
            r[p + 1],
            r[p + 2],
            0,
            r[p + 3],
            r[p + 4],
            r[p + 5],
            0,
            r[p + 6],
            r[p + 7],
            r[p + 8],
            0,
            0,
            0,
            0,
            1,
          ),
        );
        mesh.updateMatrix();
        if (preview && !live && preview.poses.some((p) => p.id === mesh.userData.body))
          mesh.applyMatrix4(preview.delta);
        mesh.visible = live || !world.view.hidden.has(mesh.userData.body);
        const material = mesh.material as THREE.MeshStandardMaterial;
        material.wireframe = !live && world.display.wireframe;
        const selected = !live && world.selected.includes(mesh.userData.body);
        material.emissive.set(selected ? '#241a09' : '#000000');
        mesh.children[0].visible = selected;
      }
      grid.visible = !live && world.display.grid;
      const shownCamera =
        preview?.camera && !live ? transformCamera(preview.camera, preview.delta) : frame.camera;
      setCamera(helperCamera, shownCamera);
      helperCamera.far = Math.max(
        0.2,
        Math.min(
          2,
          new THREE.Vector3()
            .fromArray(shownCamera.position)
            .distanceTo(new THREE.Vector3().fromArray(shownCamera.target)) * 0.25,
        ),
      );
      helperCamera.updateProjectionMatrix();
      helper.update();
      cameraBody.position.copy(helperCamera.position);
      cameraBody.quaternion.copy(helperCamera.quaternion);
      cameraBody.material.color.set(world.cameraSelected ? 0xfab387 : 0x89b4fa);
      cameraHit.position.copy(cameraBody.position);
      cameraHit.quaternion.copy(cameraBody.quaternion);
      helper.visible = cameraBody.visible =
        !live && world.view.mode === 'free' && world.view.cameraVisible;
      cameraHit.visible = helper.visible;
      if (!preview) {
        const poses = chosen();
        if (
          (poses.length || world.cameraSelected) &&
          world.display.manipulator &&
          world.cursor === null &&
          !world.busy &&
          !live
        ) {
          proxy.position.copy(
            world.cameraSelected
              ? new THREE.Vector3().fromArray(world.camera.position)
              : poses
                  .reduce(
                    (sum, p) => sum.add(new THREE.Vector3().fromArray(p.position)),
                    new THREE.Vector3(),
                  )
                  .divideScalar(poses.length),
          );
          proxy.quaternion.identity();
          gizmo.attach(proxy);
          gizmo.setMode(world.display.gizmo);
        } else gizmo.detach();
      }
      gizmo.getHelper().visible = !live && !!gizmo.object && preview?.kind !== 'modal';
      controls.enabled = !preview && !world.busy;
      orientation.update(camera, !!preview || world.busy);
      renderer.render(scene, live ? recordCamera : camera);
    };
    renderer.setAnimationLoop(() => render());

    return () => {
      cancel();
      if (world.interaction === interaction) world.interaction = undefined;
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerdown', onModalDown, true);
      document.removeEventListener('keydown', onModalKey, true);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', cancel);
      renderer.setAnimationLoop(null);
      resize.disconnect();
      themeObserver.disconnect();
      controls.dispose();
      gizmo.dispose();
      orientation.dispose();
      meshes.forEach((mesh) => {
        const outline = mesh.children[0] as THREE.LineSegments;
        outline.geometry.dispose();
        (outline.material as THREE.Material).dispose();
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      });
      helper.dispose();
      cameraBody.geometry.dispose();
      cameraBody.material.dispose();
      cameraHit.geometry.dispose();
      cameraHit.material.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [world]);
  return (
    <div
      className="viewport"
      ref={host}
      aria-label="Interactive 3D scene"
      data-hint="G Move · R Rotate · Orbit: drag · Pan: right drag · Zoom: scroll"
    />
  );
}
