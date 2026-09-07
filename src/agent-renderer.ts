import * as THREE from 'three';
import type { World } from './runtime.ts';
export function createAgentRenderer(world: World) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#181825');
  const camera = new THREE.PerspectiveCamera(38, 1024 / 768, 0.01, 1000);
  camera.up.set(0, 0, 1);
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(1024, 768);
  renderer.shadowMap.enabled = true;
  scene.add(new THREE.HemisphereLight(0xc6d3e8, 0x525057, 2));
  const light = new THREE.DirectionalLight(0xffefd9, 2.5);
  light.position.set(-1, -2, 5);
  scene.add(light);
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

  const rotation = new THREE.Matrix4();
  return {
    capture: () => {
      camera.position.fromArray(world.camera.position);
      camera.lookAt(new THREE.Vector3().fromArray(world.camera.target));
      const data = world.data;
      meshes.forEach((mesh, i) => {
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
      });
      renderer.render(scene, camera);
      return renderer.domElement.toDataURL('image/png');
    },
    dispose: () => {
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
          o.geometry.dispose();
          const materials = Array.isArray(o.material) ? o.material : [o.material];
          materials.forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
