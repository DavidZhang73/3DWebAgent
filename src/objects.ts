import { World } from './runtime.ts';
import { Vector3 } from 'three';
import type { Assets, ObjectInfo } from './types.ts';
export type ObjPart = { name: string; positions: number[][]; faces: number[][] };
export function isPlanar(points: number[][]) {
  const origin = new Vector3().fromArray(points[0]),
    edges = points.map((p) => new Vector3().fromArray(p).sub(origin));
  const longest = edges.reduce((a, b) => (a.lengthSq() > b.lengthSq() ? a : b)),
    normal = edges
      .map((e) => new Vector3().crossVectors(longest, e))
      .reduce((a, b) => (a.lengthSq() > b.lengthSq() ? a : b));
  if (normal.lengthSq() < 1e-24) throw new Error('OBJ surface is degenerate.');
  normal.normalize();
  return edges.every((e) => Math.abs(normal.dot(e)) <= Math.max(1e-12, longest.length() * 1e-10));
}
export function parseOBJ(text: string): ObjPart[] {
  const vertices: number[][] = [],
    parts: ObjPart[] = [];
  let name = 'Object',
    faces: number[][] = [];
  const flush = () => {
    if (!faces.length) return;
    const used = [...new Set(faces.flat())],
      map = new Map(used.map((v, i) => [v, i + 1]));
    parts.push({
      name,
      positions: used.map((i) => vertices[i]),
      faces: faces.map((f) => f.map((i) => map.get(i)!)),
    });
    faces = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [tag, ...values] = line.split(/\s+/);
    if (tag === 'v') {
      const v = values.slice(0, 3).map(Number);
      if (v.length !== 3 || !v.every(Number.isFinite)) throw new Error('Invalid OBJ vertex.');
      vertices.push(v);
    }
    if (tag === 'o' || tag === 'g') {
      flush();
      name = values.join(' ') || 'Object';
    }
    if (tag === 'f') {
      const f = values.map((v) => {
        const n = Number(v.split('/')[0]);
        const i = n < 0 ? vertices.length + n : n - 1;
        if (!Number.isInteger(n) || n === 0 || i < 0 || i >= vertices.length)
          throw new Error('Invalid OBJ face index.');
        return i;
      });
      if (f.length < 3) throw new Error('OBJ face has fewer than three vertices.');
      for (let i = 1; i < f.length - 1; i++) faces.push([f[0], f[i], f[i + 1]]);
    }
  }
  flush();
  if (!parts.length) throw new Error('OBJ has no triangle surfaces.');
  return parts;
}
function documentFor(world: World, path = 'model.xml') {
  const doc = new DOMParser().parseFromString(
    new TextDecoder().decode(world.assets[path]),
    'application/xml',
  );
  if (doc.querySelector('parsererror')) throw new Error('Invalid model XML.');
  return doc;
}
async function transaction(world: World, label: string, action: () => Promise<World>) {
  if (!world.canConfigure)
    throw new Error('Object structure and physics are locked after recording starts.');
  world.busy = true;
  world.notify();
  try {
    const next = await action();
    next.inheritEditor(world);
    next.finishEdit(label);
    return next;
  } finally {
    world.busy = false;
    world.notify();
  }
}
async function rebuild(
  world: World,
  doc: Document,
  assets: Assets,
  catalog: ObjectInfo[],
  path = 'model.xml',
) {
  assets[path] = new TextEncoder().encode(new XMLSerializer().serializeToString(doc));
  const next = await World.create(assets, undefined, catalog);
  try {
    next.episode.manifest.id = world.episode.manifest.id;
    next.groupCounter = world.groupCounter;
    next.episode.manifest.name = world.episode.manifest.name;
    next.episode.manifest.units = world.episode.manifest.units;
    next.configure(world.config);
    const sameLayout =
      world.stateSize === next.stateSize &&
      catalog.length === world.episode.manifest.objects.length &&
      catalog.every((o, i) => o.id === world.episode.manifest.objects[i].id);
    if (sameLayout) next.restore(next.data, world.snapshot());
    else {
      next.data.time = world.data.time;
      for (const key of ['ctrl', 'act', 'mocap_pos', 'mocap_quat', 'userdata'] as const) {
        const from = world.data[key],
          to = next.data[key];
        to.set(Array.from(from).slice(0, to.length));
      }
      // The WASM binding cannot expose memory_view<bool>; copy equality activity through the state API.
      if (world.model.neq && next.model.neq) {
        const spec = world.mj.mjtState.mjSTATE_EQ_ACTIVE.value;
        const from = new world.mj.DoubleBuffer(world.model.neq),
          to = new next.mj.DoubleBuffer(next.model.neq);
        try {
          world.mj.mj_getState(world.model, world.data, from, spec);
          next.mj.mj_getState(next.model, next.data, to, spec);
          const values = Array.from(to.GetView()) as number[];
          (Array.from(from.GetView()) as number[])
            .slice(0, values.length)
            .forEach((v, i) => (values[i] = v));
          next.mj.mj_setState(next.model, next.data, values, spec);
        } finally {
          from.delete();
          to.delete();
        }
      }
      for (const o of catalog) {
        const b = world.body(o.id),
          nb = next.body(o.id);
        if (b < 1) continue;
        next.data.xfrc_applied.set(
          Array.from(world.data.xfrc_applied).slice(b * 6, b * 6 + 6),
          nb * 6,
        );
        for (let k = 0; k < Math.min(world.model.body_jntnum[b], next.model.body_jntnum[nb]); k++) {
          const j = world.model.body_jntadr[b] + k,
            nj = next.model.body_jntadr[nb] + k,
            type = world.model.jnt_type[j];
          if (type !== next.model.jnt_type[nj])
            throw new Error('Joint layout changed unexpectedly.');
          const q = world.model.jnt_qposadr[j],
            nq = next.model.jnt_qposadr[nj],
            v = world.model.jnt_dofadr[j],
            nv = next.model.jnt_dofadr[nj];
          const qn = type === 0 ? 7 : type === 1 ? 4 : 1,
            vn = type === 0 ? 6 : type === 1 ? 3 : 1;
          next.data.qpos.set(Array.from(world.data.qpos).slice(q, q + qn), nq);
          for (const key of ['qvel', 'qacc_warmstart', 'qfrc_applied'] as const)
            next.data[key].set(Array.from(world.data[key]).slice(v, v + vn), nv);
        }
      }
    }
    const ids = new Set(catalog.map((o) => o.id));
    next.groups = world.groups
      .map((g) => ({ ...g, members: g.members.filter((id) => ids.has(id)) }))
      .filter((g) => g.members.length >= 2);
    next.camera = structuredClone(world.camera);
    next.restore(next.data, next.snapshot(0));
    next.episode.initial = next.snapshot(0);
    return next;
  } catch (e) {
    next.dispose();
    throw e;
  }
}
export async function importOBJ(world: World, files: File[]) {
  return transaction(world, 'Import OBJ', async () => {
    if (!files.length) throw new Error('Choose OBJ files.');
    const doc = documentFor(world),
      assets = { ...world.assets },
      catalog = structuredClone(world.episode.manifest.objects);
    const root = doc.documentElement;
    let asset = root.querySelector('asset');
    if (!asset) {
      asset = doc.createElement('asset');
      root.prepend(asset);
    }
    const bodies = root.querySelector('worldbody')!;
    for (const file of files) {
      if (!file.name.toLowerCase().endsWith('.obj')) throw new Error('Choose OBJ files.');
      const parts = parseOBJ(await file.text());
      for (const part of parts) {
        const id = 'object-' + crypto.randomUUID(),
          path = 'meshes/' + id + '.obj';
        const bounds = [0, 1, 2].map((a) =>
          part.positions.reduce(
            ([lo, hi], v) => [Math.min(lo, v[a]), Math.max(hi, v[a])],
            [Infinity, -Infinity],
          ),
        );
        const center = bounds.map(([lo, hi]) => (lo + hi) / 2);
        const points = part.positions.map((v) => v.map((x, a) => x - center[a])),
          planar = isPlanar(points);
        let faces = part.faces;
        // MuJoCo requires four mesh vertices; subdivide a lone triangle without changing its surface.
        if (points.length === 3) {
          points.push([0, 1, 2].map((a) => points.reduce((s, p) => s + p[a], 0) / 3));
          faces = faces.flatMap(([a, b, c]) => [
            [a, b, 4],
            [b, c, 4],
            [c, a, 4],
          ]);
        }
        assets[path] = new TextEncoder().encode(
          points.map((v) => 'v ' + v.join(' ')).join('\n') +
            '\n' +
            faces.map((f) => 'f ' + f.join(' ')).join('\n') +
            '\n',
        );
        const mesh = doc.createElement('mesh');
        mesh.setAttribute('name', id);
        mesh.setAttribute('file', path);
        mesh.setAttribute('inertia', 'shell');
        asset.append(mesh);
        const body = doc.createElement('body');
        body.setAttribute('name', id);
        body.setAttribute('pos', center.join(' '));
        body.append(doc.createElement('freejoint'));
        const inertial = doc.createElement('inertial');
        inertial.setAttribute('pos', '0 0 0');
        inertial.setAttribute('mass', '1');
        inertial.setAttribute('diaginertia', '0.1 0.1 0.1');
        body.append(inertial);
        const geom = doc.createElement('geom');
        geom.setAttribute('type', 'mesh');
        geom.setAttribute('mesh', id);
        geom.setAttribute('rgba', '.70 .73 .79 1');
        if (planar) {
          geom.setAttribute('contype', '0');
          geom.setAttribute('conaffinity', '0');
        }
        body.append(geom);
        bodies.append(body);
        catalog.push({
          id,
          name:
            parts.length === 1 ? file.name.replace(/\.obj$/i, '') : file.name + ' / ' + part.name,
          type: 'rigid',
        });
      }
    }
    const next = await rebuild(world, doc, assets, catalog);
    if (!world.episode.manifest.objects.length) {
      next.camera = next.fittedCamera();
      next.episode.initial = next.snapshot(0);
    }
    return next;
  });
}
export type ObjectChange = {
  mass?: number;
  centerOfMass?: number[];
  inertia?: number[];
  inertiaQuaternion?: number[];
  slidingFriction?: number;
  geometry?: { index: number; friction?: number[]; condim?: number };
};
function finite(values: number[], length: number, label: string) {
  if (values.length !== length || !values.every(Number.isFinite))
    throw new Error('Invalid ' + label + '.');
  return values;
}
function objectDocument(world: World, id: string) {
  for (const path of Object.keys(world.assets).filter((p) => p.endsWith('.xml'))) {
    const doc = documentFor(world, path),
      body = Array.from(doc.querySelectorAll('body')).find((b) => b.getAttribute('name') === id);
    if (body) return { doc, body, path };
  }
  throw new Error('Edit this generated object in its source model.');
}
export async function editObject(world: World, id: string, change: ObjectChange) {
  return transaction(world, 'Object Physics', async () => {
    const object = world.object(id),
      { doc, body, path } = objectDocument(world, id);
    const inertialEdit =
      change.mass !== undefined ||
      change.inertia !== undefined ||
      change.centerOfMass !== undefined ||
      change.inertiaQuaternion !== undefined;
    if (inertialEdit) {
      if (!object.movable) throw new Error('Inertia editing requires an independent free body.');
      if (
        Object.keys(world.assets)
          .filter((p) => p.endsWith('.xml'))
          .some((p) => documentFor(world, p).querySelector('compiler[inertiafromgeom="true"]'))
      )
        throw new Error('The source model forces geometry-derived inertia.');
      const mass = change.mass ?? object.mass;
      if (!Number.isFinite(mass) || mass <= 0) throw new Error('Mass must be positive.');
      const inertia = finite(
        change.inertia ?? object.inertia.map((v) => (v * mass) / object.mass),
        3,
        'inertia',
      );
      if (
        inertia.some((v) => v <= 0) ||
        inertia.some((v, i) => v > inertia[(i + 1) % 3] + inertia[(i + 2) % 3] + 1e-12)
      )
        throw new Error(
          'Principal inertia must be positive and satisfy the triangle inequalities.',
        );
      const pos = finite(change.centerOfMass ?? object.centerOfMass, 3, 'center of mass');
      const quat = finite(
          change.inertiaQuaternion ?? object.inertiaQuaternion,
          4,
          'inertia orientation',
        ),
        norm = Math.hypot(...quat);
      if (norm < 1e-8) throw new Error('Inertia quaternion cannot be zero.');
      let inertial = Array.from(body.children).find((e) => e.tagName === 'inertial');
      if (!inertial) {
        inertial = doc.createElement('inertial');
        body.prepend(inertial);
      }
      for (const key of ['fullinertia', 'axisangle', 'xyaxes', 'zaxis', 'euler'])
        inertial.removeAttribute(key);
      inertial.setAttribute('mass', String(mass));
      inertial.setAttribute('pos', pos.join(' '));
      inertial.setAttribute('diaginertia', inertia.join(' '));
      inertial.setAttribute('quat', quat.map((v) => v / norm).join(' '));
    }
    if (change.slidingFriction !== undefined || change.geometry) {
      const reason = world.collisionReason(id);
      if (reason) throw new Error(reason);
      const geoms = Array.from(body.children).filter((e) => e.tagName === 'geom');
      if (geoms.length !== object.geometries.length)
        throw new Error('Edit generated or framed geometry in its source model.');
      if (
        change.slidingFriction !== undefined &&
        (!Number.isFinite(change.slidingFriction) || change.slidingFriction < 0)
      )
        throw new Error('Friction must be non-negative.');
      if (
        change.geometry &&
        !object.geometries.some((g) => g.index === change.geometry!.index && g.collidable)
      )
        throw new Error('Unknown collision geometry.');
      object.geometries.forEach((g, i) => {
        if (!g.collidable) return;
        const patch = change.geometry?.index === g.index ? change.geometry : undefined;
        const friction = patch?.friction ?? [
          change.slidingFriction ?? g.friction[0],
          g.friction[1],
          g.friction[2],
        ];
        if (finite(friction, 3, 'friction').some((v) => v < 0))
          throw new Error('Friction must be non-negative.');
        geoms[i].setAttribute('friction', friction.join(' '));
        if (patch?.condim !== undefined) {
          if (![1, 3, 4, 6].includes(patch.condim)) throw new Error('Invalid contact dimension.');
          geoms[i].setAttribute('condim', String(patch.condim));
        }
      });
    }
    return rebuild(
      world,
      doc,
      { ...world.assets },
      structuredClone(world.episode.manifest.objects),
      path,
    );
  });
}
export async function removeObjects(world: World, ids: string[]) {
  return transaction(world, 'Delete Objects', async () => {
    if (!ids.length) throw new Error('Select objects to delete.');
    const assets = { ...world.assets },
      removed = new Set<string>();
    for (const id of ids) {
      if (removed.has(id)) continue;
      const { doc, body, path } = objectDocument({ ...world, assets } as World, id);
      for (const child of [body, ...Array.from(body.querySelectorAll('body'))]) {
        const name = child.getAttribute('name');
        if (name) removed.add(name);
      }
      body.remove();
      assets[path] = new TextEncoder().encode(new XMLSerializer().serializeToString(doc));
    }
    const doc = new DOMParser().parseFromString(
      new TextDecoder().decode(assets['model.xml']),
      'application/xml',
    );
    return rebuild(
      world,
      doc,
      assets,
      world.episode.manifest.objects.filter((o) => !removed.has(o.id)),
    );
  });
}
