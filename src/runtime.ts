import type { MainModule, MjModel, MjData, DoubleBuffer } from '@mujoco/mujoco';
import { Quaternion, Vector3 } from 'three';
import { hashes, safePath, validateEpisode, validateFrame, validateRuntime } from './archive.ts';
import { defaultCamera, defaultRuntime, PRODUCER, LIFECYCLE_TOOLS } from './types.ts';
import type {
  Assets,
  Episode,
  Frame,
  Group,
  CameraState,
  Input,
  ToolName,
  Source,
  RuntimeConfig,
  ObjectInfo,
  Vec3,
  ObjectPose,
  CommandName,
  McpCall,
} from './types.ts';
import { DEFINITIONS, validateInput } from './capabilities.ts';
import { cameraAxes, movedCamera, rotationFor } from './pose.ts';
import { EditHistory, checkpoint } from './edit-history.ts';
const arr = (v: ArrayLike<number>, start = 0, count = v.length) =>
  Array.from(v).slice(start, start + count);
export const EMPTY_XML =
  '<mujoco model="Untitled"><compiler angle="radian"/><option timestep="0.002"/><asset/><worldbody><geom name="ground" type="plane" size="5 5 .1" rgba=".25 .27 .30 1"/></worldbody></mujoco>';
export class World {
  static engine: () => Promise<MainModule>;
  static captureFactory?: (world: World) => Promise<{ capture: () => string; dispose: () => void }>;
  episode!: Episode;
  camera: CameraState = defaultCamera();
  groups: Group[] = [];
  selected: string[] = [];
  cameraSelected = false;
  activeGroup: string | null = null;
  view = {
    mode: 'free' as 'free' | 'camera',
    camera: defaultCamera(),
    hidden: new Set<string>(),
    locked: new Set<string>(),
    cameraVisible: true,
  };
  editHistory!: EditHistory;
  interaction?: { begin: (mode: 'translate' | 'rotate') => void; cancel: () => void };
  playback?: () => void;
  status = '';
  renameRequested = 0;
  cursor: number | null = null;
  traceCursor: number | null = null;
  busy = false;
  dirty = false;
  revision = 0;
  error = '';
  display = {
    grid: true,
    wireframe: false,
    manipulator: true,
    gizmo: 'translate' as 'translate' | 'rotate',
  };
  captureImage?: () => string | Promise<string>;
  private captureDispose?: () => void;
  groupCounter = 0;
  private activeCall?: McpCall;
  cancelAtStep?: number;
  private step = 0;
  listeners = new Set<() => void>();
  private buffer: DoubleBuffer;
  readonly data: MjData;
  readonly history: MjData;
  readonly stateSpec: number;
  readonly stateSize: number;
  private originalCollision: [number[], number[]];
  readonly mj: MainModule;
  readonly model: MjModel;
  readonly assets: Assets;
  private directory: string;
  private constructor(mj: MainModule, model: MjModel, assets: Assets, directory: string) {
    this.mj = mj;
    this.model = model;
    this.assets = assets;
    this.directory = directory;
    this.data = new mj.MjData(model);
    this.history = new mj.MjData(model);
    this.stateSpec = mj.mjtState.mjSTATE_INTEGRATION.value;
    this.stateSize = mj.mj_stateSize(model, this.stateSpec);
    this.buffer = new mj.DoubleBuffer(this.stateSize);
    this.originalCollision = [arr(model.geom_contype), arr(model.geom_conaffinity)];
    for (const k of ['mj', 'model', 'data', 'history', 'buffer'])
      Object.defineProperty(this, k, { enumerable: false });
  }
  static async create(
    assets: Assets = { 'model.xml': new TextEncoder().encode(EMPTY_XML) },
    episode?: Episode,
    catalog?: ObjectInfo[],
  ) {
    if (episode) {
      validateEpisode(episode);
      if (episode.manifest.requiredCapabilities.some((c) => c !== 'state'))
        throw new Error('Unsupported runtime capability.');
    }
    const mj = await World.engine(),
      directory = '/world-' + crypto.randomUUID();
    mj.FS.mkdir(directory);
    let model: MjModel | undefined, world: World | undefined;
    try {
      for (const [path, bytes] of Object.entries(assets)) {
        if (path.endsWith('.xml'))
          for (const match of new TextDecoder()
            .decode(bytes)
            .matchAll(/\b(file|meshdir|texturedir|assetdir)\s*=\s*["']([^"']*)["']/g)) {
            const reference = match[1] === 'file' ? match[2] : match[2].replace(/\/$/, '');
            if (reference.includes('&')) throw new Error('Encoded resource paths are unsupported.');
            if (reference) safePath(reference);
          }
        safePath(path);
        const full = directory + '/' + path;
        mj.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')), 0o777);
        mj.FS.writeFile(full, bytes);
      }
      model = mj.MjModel.mj_loadXML(directory + '/model.xml');
      if (!model) throw new Error('Model compilation failed.');
      if (model.nplugin || model.nflex || model.nskin || model.ntex)
        throw new Error('Only untextured rigid models are supported in this release.');
      if (arr(model.geom_type).some((t) => ![0, 2, 3, 4, 5, 6, 7].includes(t)))
        throw new Error('Unsupported geometry.');
      if (
        !Number.isFinite(model.opt.timestep) ||
        model.opt.timestep <= 0 ||
        model.opt.timestep > 0.1
      )
        throw new Error('Invalid timestep.');
      world = new World(mj, model, assets, directory);
      const objects =
        catalog ??
        Array.from({ length: model.nbody - 1 }, (_, i) => ({
          id: world!.name(i + 1),
          name: world!.name(i + 1),
          type: 'rigid' as const,
        }));
      const manifest = episode?.manifest ?? {
        format: '3dwebagent-episode' as const,
        version: 1 as const,
        id: crypto.randomUUID(),
        contract: '3dwebagent-runtime-1' as const,
        lifecycle: 'setup' as const,
        originTime: 0,
        requiredCapabilities: ['state'],
        producer: { ...PRODUCER },
        engine: '3.12.0' as const,
        name: 'Untitled',
        units: 'SI' as const,
        stateSpec: world.stateSpec,
        stateSize: world.stateSize,
        runtime: defaultRuntime(),
        objects,
        hashes: await hashes(assets),
      };
      if (
        manifest.stateSpec !== world.stateSpec ||
        manifest.stateSize !== world.stateSize ||
        manifest.objects.length !== model.nbody - 1 ||
        manifest.objects.some((o) => world!.body(o.id) < 1)
      )
        throw new Error('Episode object catalog or state layout does not match the model.');
      world.episode = {
        manifest: structuredClone(manifest),
        assets,
        initial: world.snapshot(0),
        states: [],
        events: [],
        trajectory: [],
        observations: {},
        revision: 0,
      };
      world.applyPhysics();
      mj.mj_forward(model, world.data);
      if (episode) {
        world.episode = {
          ...structuredClone(episode),
          assets,
          manifest: structuredClone(manifest),
        };
        world.restoreLive(episode.states.at(-1) ?? episode.initial);
      } else world.episode.initial = world.snapshot(0);
      world.view.camera = structuredClone(world.camera);
      world.view.mode = world.recording ? 'camera' : 'free';
      world.editHistory = new EditHistory(world.episode);
      return world;
    } catch (e) {
      if (world) world.dispose();
      else {
        model?.delete();
        World.removeDirectory(mj, directory);
      }
      throw e;
    }
  }
  private static removeDirectory(mj: MainModule, path: string) {
    for (const n of mj.FS.readdir(path)) {
      if (n === '.' || n === '..') continue;
      const p = path + '/' + n;
      if (mj.FS.isDir(mj.FS.stat(p, false).mode)) World.removeDirectory(mj, p);
      else mj.FS.unlink(p);
    }
    mj.FS.rmdir(path);
  }
  get capabilities() {
    return [
      'state',
      ...Object.keys(DEFINITIONS).filter(
        (name) => name !== 'capture_scene' || !!World.captureFactory || !!this.captureImage,
      ),
    ];
  }
  get config() {
    return this.episode.manifest.runtime;
  }
  get frames() {
    return [this.episode.initial, ...this.episode.states];
  }
  get recording() {
    return this.episode.manifest.lifecycle !== 'setup';
  }
  get currentFrame() {
    if (this.traceCursor !== null) return this.episode.trajectory[this.traceCursor];
    return this.cursor === null
      ? this.snapshot(this.episode.states.length)
      : this.frames[this.cursor];
  }
  get canConfigure() {
    return !this.recording && !this.busy && this.cursor === null;
  }
  get canUndo() {
    return this.canConfigure && this.editHistory.index > 0;
  }
  get canRedo() {
    return this.canConfigure && this.editHistory.index < this.editHistory.entries.length - 1;
  }
  refreshDirty() {
    this.dirty = this.editHistory?.isDirty(this.episode) ?? true;
  }
  markSaved() {
    this.editHistory.markSaved(this.episode);
    this.refreshDirty();
    this.notify();
  }
  finishEdit(label: string) {
    this.editHistory?.record(label, this.episode);
    this.refreshDirty();
    this.notify();
  }
  inheritEditor(previous: World) {
    this.editHistory = previous.editHistory;
    this.view = {
      ...previous.view,
      camera: structuredClone(previous.view.camera),
      hidden: new Set(previous.view.hidden),
      locked: new Set(previous.view.locked),
    };
    this.display = { ...previous.display };
    const ids = new Set(this.episode.manifest.objects.map((o) => o.id));
    this.selected = previous.selected.filter((id) => ids.has(id));
    this.cameraSelected = previous.cameraSelected;
    this.activeGroup = this.groups.some((g) => g.id === previous.activeGroup)
      ? previous.activeGroup
      : null;
  }
  async restoreEdit(index: number) {
    if (!this.canConfigure || !Number.isInteger(index) || !this.editHistory.entries[index])
      throw new Error('Edit history is unavailable.');
    if (index === this.editHistory.index) return this;
    this.busy = true;
    this.notify();
    try {
      const ep = checkpoint(this.editHistory.entries[index].episode);
      const next = await World.create(ep.assets, ep);
      next.inheritEditor(this);
      next.editHistory.index = index;
      next.refreshDirty();
      return next;
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  select(ids: string[], toggle = false) {
    if (this.busy) return;
    this.cameraSelected = false;
    this.activeGroup = null;
    this.selected = toggle
      ? [
          ...this.selected.filter((id) => !ids.includes(id)),
          ...ids.filter((id) => !this.selected.includes(id)),
        ]
      : [...new Set(ids)];
    this.notify();
  }
  selectCamera() {
    if (this.busy) return;
    this.selected = [];
    this.activeGroup = null;
    this.cameraSelected = true;
    this.notify();
  }
  selectGroup(id: string) {
    const group = this.currentFrame.groups.find((g) => g.id === id);
    if (!group || this.busy) return;
    this.select(group.members);
    this.activeGroup = id;
    this.notify();
  }
  setViewCamera(camera: CameraState) {
    validateFrame({ ...this.currentFrame, camera }, this.episode.manifest);
    this.view.camera = structuredClone(camera);
    this.view.mode = 'free';
    this.notify();
  }
  toggleCameraView() {
    if (this.busy) return;
    this.view.mode = this.view.mode === 'camera' ? 'free' : 'camera';
    this.notify();
  }
  frameSelection(all = false) {
    if (this.busy) return;
    if (!all && this.cameraSelected) {
      const c = this.currentFrame.camera;
      this.setViewCamera({
        position: [c.position[0] + 1, c.position[1] - 1, c.position[2] + 1],
        target: [...c.position],
      });
    } else
      this.setViewCamera(
        this.fittedCamera(!all && this.selected.length ? this.selected : undefined),
      );
  }
  private editableName(name: string) {
    const value = name.trim();
    if (!value || value.length > 200) throw new Error('Name must contain 1–200 characters.');
    return value;
  }
  renameObject(id: string, name: string) {
    if (!this.canConfigure) throw new Error('Names are locked after recording starts.');
    const object = this.episode.manifest.objects.find((o) => o.id === id);
    if (!object) throw new Error('Unknown object.');
    object.name = this.editableName(name);
    this.finishEdit('Rename Object');
  }
  renameGroup(id: string, name: string) {
    if (!this.canConfigure) throw new Error('Names are locked after recording starts.');
    const group = this.groups.find((g) => g.id === id);
    if (!group) throw new Error('Unknown group.');
    group.name = this.editableName(name);
    this.episode.initial = this.snapshot(0);
    this.finishEdit('Rename Group');
  }
  setMetadata(change: { name?: string; units?: 'SI' | 'normalized' }) {
    if (!this.canConfigure) throw new Error('Scene settings are locked after recording starts.');
    if (change.name !== undefined) this.episode.manifest.name = this.editableName(change.name);
    if (change.units !== undefined) {
      if (!['SI', 'normalized'].includes(change.units)) throw new Error('Invalid units.');
      this.episode.manifest.units = change.units;
    }
    this.finishEdit('Scene Settings');
  }
  hasContactPair(body: number) {
    for (let p = 0; p < this.model.npair; p++)
      if (
        this.model.geom_bodyid[this.model.pair_geom1[p]] === body ||
        this.model.geom_bodyid[this.model.pair_geom2[p]] === body
      )
        return true;
    return false;
  }
  collisionReason(id: string) {
    if (this.hasContactPair(this.body(id)))
      return 'Explicit contact pairs must be edited in the source model.';
    if (!this.object(id).geometries.some((g) => g.collidable))
      return 'This object has no collision geometry.';
    return '';
  }
  setCollisionEnabled(id: string, enabled: boolean) {
    if (!this.canConfigure) throw new Error('Physics settings are locked after recording starts.');
    const reason = this.collisionReason(id);
    if (reason) throw new Error(reason);
    const object = this.episode.manifest.objects.find((o) => o.id === id)!;
    if (enabled) delete object.collisionEnabled;
    else object.collisionEnabled = false;
    this.applyPhysics();
    this.finishEdit('Object Collision');
  }
  async editPoses(poses: ObjectPose[], label = 'Transform Objects') {
    return this.command('edit_poses', { poses }, 'manual', () => this.applyPoses(poses, label));
  }
  private applyPoses(poses: ObjectPose[], label = 'Transform Objects') {
    validateInput('edit_poses', { poses });
    if (
      !Array.isArray(poses) ||
      !poses.length ||
      new Set(poses.map((p) => p.id)).size !== poses.length
    )
      throw new Error('Invalid poses.');
    for (const pose of poses) {
      this.address(pose.id);
      validateInput('set_object_pose', pose);
      if (Math.hypot(...pose.quaternion) < 1e-8) throw new Error('Quaternion cannot be zero.');
    }
    return this.commit(
      'manual',
      true,
      () => {
        for (const pose of poses) {
          const a = this.address(pose.id),
            q = new Quaternion(
              pose.quaternion[1],
              pose.quaternion[2],
              pose.quaternion[3],
              pose.quaternion[0],
            ).normalize();
          this.data.qpos.set(pose.position, a.q);
          this.data.qpos.set([q.w, q.x, q.y, q.z], a.q + 3);
          this.data.qvel.fill(0, a.v, a.v + 6);
        }
      },
      undefined,
      undefined,
      label,
    );
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  notify = () => {
    this.revision++;
    this.listeners.forEach((fn) => fn());
  };
  name(id: number) {
    return this.mj.mj_id2name(this.model, this.mj.mjtObj.mjOBJ_BODY.value, id) || 'body-' + id;
  }
  body(id: string) {
    return this.mj.mj_name2id(this.model, this.mj.mjtObj.mjOBJ_BODY.value, id);
  }
  private address(id: string) {
    const b = this.body(id),
      j = this.model.body_jntadr[b];
    if (
      b < 1 ||
      this.model.body_parentid[b] !== 0 ||
      this.model.body_jntnum[b] !== 1 ||
      this.model.jnt_type[j] !== 0
    )
      throw new Error('Object requires an independent free joint: ' + id);
    return { body: b, q: this.model.jnt_qposadr[j], v: this.model.jnt_dofadr[j] };
  }
  private resolve(ids: string[]) {
    const result = [
      ...new Set(ids.flatMap((id) => this.groups.find((g) => g.id === id)?.members ?? [id])),
    ];
    result.forEach((id) => this.address(id));
    return result;
  }
  object(id: string, data = this.data) {
    const b = this.body(id),
      info = this.episode.manifest.objects.find((o) => o.id === id);
    if (b < 1 || !info) throw new Error('Unknown object: ' + id);
    return {
      ...info,
      position: arr(data.xpos, b * 3, 3),
      quaternion: arr(data.xquat, b * 4, 4),
      velocity: arr(data.cvel, b * 6, 6),
      mass: this.model.body_mass[b],
      movable:
        this.model.body_parentid[b] === 0 &&
        this.model.body_jntnum[b] === 1 &&
        this.model.jnt_type[this.model.body_jntadr[b]] === 0,
      inertia: arr(this.model.body_inertia, b * 3, 3),
      centerOfMass: arr(this.model.body_ipos, b * 3, 3),
      inertiaQuaternion: arr(this.model.body_iquat, b * 4, 4),
      geometries: Array.from({ length: this.model.ngeom }, (_, g) => g)
        .filter((g) => this.model.geom_bodyid[g] === b)
        .map((g) => ({
          index: g,
          type: this.model.geom_type[g],
          size: arr(this.model.geom_size, g * 3, 3),
          friction: arr(this.model.geom_friction, g * 3, 3),
          condim: this.model.geom_condim[g],
          collidable: !!(this.originalCollision[0][g] || this.originalCollision[1][g]),
        })),
    };
  }
  contacts(data = this.data) {
    if (!this.config.physics.detection) return [];
    // Collision-only queries preserve response-disabled simulation and integration state.
    const flags = this.model.opt.disableflags;
    try {
      this.model.opt.disableflags =
        flags &
        ~this.mj.mjtDisableBit.mjDSBL_CONSTRAINT.value &
        ~this.mj.mjtDisableBit.mjDSBL_CONTACT.value;
      this.mj.mj_collision(this.model, data);
    } finally {
      this.model.opt.disableflags = flags;
    }
    const list = data.contact,
      result = [];
    try {
      for (let i = 0; i < data.ncon; i++) {
        const c = list.get(i)!;
        try {
          result.push({
            objects: [
              this.name(this.model.geom_bodyid[c.geom1]),
              this.name(this.model.geom_bodyid[c.geom2]),
            ],
            position: arr(c.pos),
            distance: c.dist,
          });
        } finally {
          c.delete();
        }
      }
    } finally {
      list.delete();
    }
    return result.sort((a, b) => {
      for (let i = 0; i < 2; i++) {
        if (a.objects[i] !== b.objects[i]) return a.objects[i] < b.objects[i] ? -1 : 1;
      }
      for (let i = 0; i < 3; i++) {
        if (a.position[i] !== b.position[i]) return a.position[i] - b.position[i];
      }
      return a.distance - b.distance;
    });
  }
  state() {
    return {
      index: this.episode.states.length,
      units: this.episode.manifest.units,
      objects: this.episode.manifest.objects.map((o) => this.object(o.id)),
      groups: structuredClone(this.groups),
      camera: structuredClone(this.camera),
      contacts: this.contacts(),
    };
  }
  snapshot(index = this.episode?.states.length ?? 0): Frame {
    this.mj.mj_getState(this.model, this.data, this.buffer, this.stateSpec);
    return {
      index,
      integration: arr(this.buffer.GetView()),
      camera: structuredClone(this.camera),
      groups: structuredClone(this.groups),
      groupCounter: this.groupCounter,
    };
  }
  restore(data: MjData, f: Frame) {
    this.mj.mj_setState(this.model, data, f.integration, this.stateSpec);
    this.mj.mj_forward(this.model, data);
    this.mj.mj_setState(this.model, data, f.integration, this.stateSpec);
  }
  restoreLive(f: Frame) {
    this.restore(this.data, f);
    this.camera = structuredClone(f.camera);
    this.groups = structuredClone(f.groups);
    this.groupCounter = f.groupCounter;
  }
  viewedData() {
    if (this.cursor === null) return this.data;
    this.restore(this.history, this.currentFrame);
    return this.history;
  }
  setCursor(index: number | null) {
    if (this.busy) throw new Error('Wait for the operation.');
    if (index !== null && (!Number.isInteger(index) || index < 0 || index >= this.frames.length))
      throw new Error('Invalid timeline index.');
    this.traceCursor = null;
    this.cursor = index;
    this.notify();
  }
  setTraceCursor(index: number) {
    if (this.busy || !Number.isInteger(index) || !this.episode.trajectory[index])
      throw new Error('Invalid trajectory index.');
    this.traceCursor = index;
    this.cursor = 0;
    this.notify();
  }
  private applyPhysics() {
    const p = this.config.physics;
    this.model.opt.gravity.set(p.enabled ? p.gravity : [0, 0, 0]);
    const disabled = new Set(
      this.episode.manifest.objects
        .filter((o) => o.collisionEnabled === false)
        .map((o) => this.body(o.id)),
    );
    for (const body of disabled)
      if (this.hasContactPair(body))
        throw new Error('Collision overrides do not support explicit contact pairs.');
    const masks = this.originalCollision.map((values) =>
      values.map((value, g) =>
        p.detection && !disabled.has(this.model.geom_bodyid[g]) ? value : 0,
      ),
    );
    this.model.geom_contype.set(masks[0]);
    this.model.geom_conaffinity.set(masks[1]);
    const contact = this.mj.mjtDisableBit.mjDSBL_CONTACT.value,
      constraint = this.mj.mjtDisableBit.mjDSBL_CONSTRAINT.value;
    this.model.opt.disableflags |= this.mj.mjtDisableBit.mjDSBL_AUTORESET.value;
    this.model.opt.disableflags =
      (this.model.opt.disableflags & ~contact & ~constraint) |
      (!p.detection ? contact : 0) |
      (!p.response ? constraint : 0);
  }
  configure(config: RuntimeConfig) {
    if (!this.canConfigure) throw new Error('Configuration is locked after recording starts.');
    validateRuntime(config);
    this.episode.manifest.runtime = structuredClone(config);
    this.applyPhysics();
    this.mj.mj_forward(this.model, this.data);
    this.episode.initial = this.snapshot(0);
    this.finishEdit('World Settings');
  }
  fittedCamera(ids?: string[]): CameraState {
    const data = this.viewedData();
    const lo = new Vector3(Infinity, Infinity, Infinity),
      hi = new Vector3(-Infinity, -Infinity, -Infinity);
    for (let g = 0; g < this.model.ngeom; g++) {
      if (
        this.model.geom_type[g] === 0 ||
        (ids && !ids.includes(this.name(this.model.geom_bodyid[g])))
      )
        continue;
      const p = new Vector3().fromArray(data.geom_xpos, g * 3),
        r = this.model.geom_rbound[g];
      lo.min(p.clone().addScalar(-r));
      hi.max(p.clone().addScalar(r));
    }
    if (!Number.isFinite(lo.x)) return defaultCamera();
    const center = lo.clone().add(hi).multiplyScalar(0.5),
      radius = Math.max(0.1, lo.distanceTo(hi) / 2);
    return {
      position: center
        .clone()
        .addScaledVector(new Vector3(1.3, -1.8, 1.5), radius)
        .toArray() as Vec3,
      target: center.toArray() as Vec3,
    };
  }
  async updateCamera(camera: CameraState, source: Source = 'manual', signal?: AbortSignal) {
    return this.command('set_camera', { camera }, source, () =>
      this.applyCamera(camera, source, signal),
    );
  }
  private applyCamera(camera: CameraState, source: Source, signal?: AbortSignal) {
    validateInput('set_camera', { camera });
    validateFrame({ ...this.snapshot(), camera }, this.episode.manifest);
    return this.commit(
      source,
      false,
      () => {
        this.camera = structuredClone(camera);
      },
      undefined,
      signal,
      'Move Camera',
    );
  }
  private trace(
    phase: 'input' | 'physics' | 'final' | 'rollback',
    applied?: { body: number; values: number[] },
  ) {
    if (!this.activeCall) return;
    const frame = this.snapshot();
    if (!frame.integration.every(Number.isFinite)) return;
    this.episode.trajectory.push({
      ...frame,
      index: this.episode.trajectory.length,
      call_id: this.activeCall.id,
      phase,
      step: this.step,
      sim_time: this.data.time - this.episode.manifest.originTime,
      ...(applied ? { applied: structuredClone(applied) } : {}),
    });
  }

  private async simulate(
    force?: { body: number; values: number[] },
    signal?: AbortSignal,
    duration?: number,
  ) {
    const p = this.config.physics,
      dt = this.model.opt.timestep;
    if (!p.enabled) return { physics: 'disabled' };
    const fixed = Math.ceil((duration ?? p.duration) / dt),
      max =
        duration !== undefined || p.strategy === 'fixed'
          ? fixed
          : Math.ceil(p.maxDuration / dt) + (force ? fixed : 0);
    let quiet = 0;
    for (let i = 0; i < max; i++) {
      if (signal?.aborted || this.cancelAtStep === this.step)
        throw new Error('Operation cancelled.');
      this.data.xfrc_applied.fill(0);
      if (force && i < fixed) this.data.xfrc_applied.set(force.values, force.body * 6);
      this.mj.mj_step(this.model, this.data);
      this.step++;
      this.trace('physics', force && i < fixed ? force : undefined);
      if (
        !arr(this.data.qpos).every(Number.isFinite) ||
        !arr(this.data.qvel).every(Number.isFinite) ||
        arr(this.data.qvel).some((v) => Math.abs(v) > 1e8)
      )
        throw new Error('Non-finite or unstable physics state.');
      let resting = true;
      for (const o of this.episode.manifest.objects) {
        const b = this.body(o.id),
          j = this.model.body_jntadr[b];
        if (this.model.body_jntnum[b] === 1 && this.model.jnt_type[j] === 0) {
          const v = this.model.jnt_dofadr[j];
          if (
            Math.hypot(...arr(this.data.qvel, v, 3)) > p.linearThreshold ||
            Math.hypot(...arr(this.data.qvel, v + 3, 3)) > p.angularThreshold
          )
            resting = false;
        }
      }
      quiet = resting && (!force || i >= fixed) ? quiet + dt : 0;
      if (duration === undefined && p.strategy === 'settle' && quiet >= p.quietDuration) {
        this.data.xfrc_applied.fill(0);
        return { physics: 'settled', steps: this.step };
      }
      if (i % 100 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    this.data.xfrc_applied.fill(0);
    return {
      physics: duration !== undefined || p.strategy === 'fixed' ? 'advanced' : 'timeout',
      steps: this.step,
    };
  }
  private async commit(
    source: Source,
    physical: boolean,
    operation: () => unknown,
    force?: { body: number; values: number[] },
    signal?: AbortSignal,
    label = 'Transform Objects',
    duration?: number,
  ) {
    if (this.busy) throw new Error('Operation is running.');
    const before = this.snapshot(),
      record = source === 'webmcp' || this.recording;
    this.busy = true;
    this.notify();
    try {
      if (signal?.aborted || this.cancelAtStep === this.step)
        throw new Error('Operation cancelled.');
      const result = operation();
      this.trace('input');
      this.mj.mj_forward(this.model, this.data);
      const physics = physical ? await this.simulate(force, signal, duration) : {};
      this.restore(this.data, this.snapshot());
      const after = this.snapshot(record ? this.episode.states.length + 1 : 0);
      validateFrame(after, this.episode.manifest);
      if (record) this.episode.states.push(after);
      else this.episode.initial = after;
      this.trace('final');
      this.finishEdit(label);
      return {
        status: 'completed',
        ...physics,
        ...(result === undefined ? {} : { result }),
        index: after.index,
      };
    } catch (e) {
      this.restoreLive(before);
      this.trace('rollback');
      throw e;
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  private start(task?: string) {
    if (this.episode.manifest.lifecycle === 'setup') {
      this.episode.initial = this.snapshot(0);
      this.episode.manifest.originTime = this.data.time;
      this.episode.manifest.lifecycle = 'active';
      if (task !== undefined) this.episode.manifest.task = task;
      this.episode.revision++;
    }
  }
  private async command(
    name: CommandName,
    input: Input,
    source: Source,
    operation: () => Promise<unknown> | unknown,
  ): Promise<unknown> {
    // History is an editor-only restriction; agent execution always targets live data.
    if (
      source === 'manual' &&
      this.cursor !== null &&
      !LIFECYCLE_TOOLS.includes(name as ToolName) &&
      !DEFINITIONS[name as ToolName]?.readOnly
    )
      throw new Error('Return to latest before editing history.');
    const m = this.episode.manifest;
    if (m.lifecycle === 'ended') {
      throw new Error('Episode has ended.');
    }
    if (source === 'webmcp' || name === 'start_episode') this.start();
    if (m.lifecycle === 'setup') {
      this.step = 0;
      return operation();
    }
    const calls = (this.episode.calls ??= []),
      call: McpCall = {
        index: calls.length,
        id: 'call-' + calls.length,
        name,
        arguments: structuredClone(input),
        actor: source === 'webmcp' ? 'agent' : 'human',
        producer: { ...PRODUCER },
        timestamp: new Date().toISOString(),
        before_index: this.episode.states.length,
        state_index: this.episode.states.length,
        trace_start: this.episode.trajectory.length,
        trace_end: this.episode.trajectory.length,
        sim_start: this.data.time - m.originTime,
        sim_end: this.data.time - m.originTime,
        steps: 0,
        status: 'completed',
      };
    calls.push(call);
    const event = (kind: 'request' | 'complete') =>
      this.episode.events.push({
        index: this.episode.events.length,
        call_id: call.id,
        kind,
        timestamp: new Date().toISOString(),
        sim_time: this.data.time - m.originTime,
      });
    event('request');
    const owner = !this.busy && !this.activeCall;
    if (owner) {
      this.activeCall = call;
      this.step = 0;
    }
    try {
      if (!owner) throw new Error('Operation is running.');
      call.result = JSON.parse(JSON.stringify((await operation()) ?? null));
      return call.result;
    } catch (e) {
      call.status = 'error';
      call.error = e instanceof Error ? e.message : String(e);
      call.error_code = errorCode(call.error);
      if (call.error_code === 'cancelled')
        call.cancellation = { phase: this.step ? 'physics' : 'input', step: this.step };
      throw e;
    } finally {
      if (owner) {
        call.state_index = this.episode.states.length;
        call.trace_end = this.episode.trajectory.length;
        call.steps = this.step;
        this.activeCall = undefined;
      }
      call.sim_end = this.data.time - m.originTime;
      event('complete');
      this.episode.revision++;
      this.refreshDirty();
      this.notify();
    }
  }
  async execute(
    name: ToolName,
    input: Input,
    source: Source = 'manual',
    signal?: AbortSignal,
  ): Promise<unknown> {
    return this.command(name, input, source, () =>
      this.executeOperation(name, input, source, signal),
    );
  }
  async executeRecorded(
    name: CommandName,
    input: Input,
    source: Source = 'webmcp',
    signal?: AbortSignal,
  ) {
    if (name === 'edit_poses') return this.editPoses(input.poses as ObjectPose[]);
    if (name === 'set_camera')
      return this.updateCamera(input.camera as CameraState, source, signal);
    return this.execute(name, input, source, signal);
  }
  private async executeOperation(
    name: ToolName,
    input: Input,
    source: Source,
    signal?: AbortSignal,
  ): Promise<unknown> {
    validateInput(name, input);
    if (source === 'webmcp' && !this.config.enabledTools.includes(name))
      throw new Error('Tool is disabled: ' + name);
    if (this.busy) throw new Error('Operation is running.');
    if (signal?.aborted || this.cancelAtStep === 0) throw new Error('Operation cancelled.');
    if (name === 'start_episode') {
      this.start(input.task as string | undefined);
      if (input.task !== undefined && this.episode.calls?.length === 1)
        this.episode.manifest.task = input.task as string;
      return { status: 'active' };
    }
    if (name === 'advance_simulation') {
      if (!this.config.physics.enabled) throw new Error('Physics is disabled.');
      const before = this.data.time;
      const result = await this.commit(
        source,
        true,
        () => {},
        undefined,
        signal,
        'Advance Simulation',
        input.duration as number,
      );
      return { ...result, duration: this.data.time - before };
    }
    if (name === 'list_objects')
      return {
        objects: structuredClone(this.episode.manifest.objects),
        groups: structuredClone(this.groups),
      };
    if (name === 'get_object') return this.object(input.id as string);
    if (name === 'get_scene')
      return {
        name: this.episode.manifest.name,
        units: this.episode.manifest.units,
        up: 'Z',
        quaternion: 'wxyz',
        runtime: structuredClone(this.config),
        objects: structuredClone(this.episode.manifest.objects),
      };
    if (name === 'get_state') return this.state();
    if (name === 'capture_scene') {
      this.busy = true;
      this.notify();
      try {
        if (!this.captureImage) {
          if (!World.captureFactory) throw new Error('Unsupported capability: capture_scene');
          const capture = await World.captureFactory(this);
          this.captureImage = capture.capture;
          this.captureDispose = capture.dispose;
        }
        const png = await this.captureImage(),
          bytes = Uint8Array.from(atob(png.split(',')[1]), (c) => c.charCodeAt(0));
        const hash = (await hashes({ image: bytes })).image;
        if (signal?.aborted) throw new Error('Operation cancelled.');
        this.episode.observations[hash + '.png'] = bytes;
        if (this.activeCall) this.activeCall.producer.renderer = 'three-r183/webgl2';
        return {
          content: [{ type: 'image', mimeType: 'image/png', observation: hash + '.png' }],
          camera: structuredClone(this.camera),
          render: { width: 1024, height: 768, pixelRatio: 1, fovy: 38, near: 0.01, far: 1000 },
        };
      } finally {
        this.busy = false;
        this.notify();
      }
    }
    if (name === 'move_camera')
      return this.applyCamera(movedCamera(this.camera, input), source, signal);
    if (name === 'ungroup_objects')
      return this.commit(
        source,
        false,
        () => {
          const ids = input.ids as string[];
          if (ids.some((id) => !this.groups.some((g) => g.id === id)))
            throw new Error('Unknown group.');
          this.groups = this.groups.filter((g) => !ids.includes(g.id));
        },
        undefined,
        signal,
        'Ungroup Objects',
      );
    const ids = this.resolve((input.ids ?? [input.id]) as string[]);
    if (name === 'group_objects')
      return this.commit(
        source,
        false,
        () => {
          if (ids.length < 2) throw new Error('At least two objects are required.');
          this.groups = this.groups.filter((g) => !g.members.some((id) => ids.includes(id)));
          const group = {
            id: 'group-' + this.episode.manifest.id + '-' + ++this.groupCounter,
            name: (input.name as string) || 'Group',
            members: ids,
          };
          this.groups.push(group);
          return group;
        },
        undefined,
        signal,
        'Group Objects',
      );
    const force =
      name === 'apply_force'
        ? { body: this.address(input.id as string).body, values: input.force as number[] }
        : undefined;
    if (force && (!this.config.physics.enabled || Math.hypot(...force.values) > 20))
      throw new Error('Force requires enabled physics and magnitude <=20 N.');
    return this.commit(
      source,
      true,
      () => {
        if (force) return;
        const axes =
          input.space === 'camera'
            ? cameraAxes(this.camera)
            : [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
        const center = input.pivot
          ? new Vector3().fromArray(input.pivot as number[])
          : ids
              .reduce(
                (s, id) => s.add(new Vector3().fromArray(this.data.qpos, this.address(id).q)),
                new Vector3(),
              )
              .divideScalar(ids.length);
        const rotation =
          name === 'rotate_objects'
            ? rotationFor(input.angles as number[], axes)
            : new Quaternion();
        const delta = new Vector3();
        if (name === 'translate_objects')
          (input.delta as number[]).forEach((v, i) => delta.addScaledVector(axes[i], v));
        for (const id of ids) {
          const a = this.address(id),
            p = new Vector3().fromArray(this.data.qpos, a.q),
            q = new Quaternion(
              this.data.qpos[a.q + 4],
              this.data.qpos[a.q + 5],
              this.data.qpos[a.q + 6],
              this.data.qpos[a.q + 3],
            );
          if (name === 'translate_objects') p.add(delta);
          if (name === 'rotate_objects') {
            p.sub(center).applyQuaternion(rotation).add(center);
            q.premultiply(rotation);
          }
          if (name === 'set_object_pose') {
            if (input.position) p.fromArray(input.position as number[]);
            if (input.quaternion) {
              const v = input.quaternion as number[];
              q.set(v[1], v[2], v[3], v[0]);
              if (q.length() < 1e-8) throw new Error('Quaternion cannot be zero.');
              q.normalize();
            }
          }
          this.data.qpos.set(p.toArray(), a.q);
          this.data.qpos.set([q.w, q.x, q.y, q.z], a.q + 3);
          this.data.qvel.fill(0, a.v, a.v + 6);
        }
      },
      force,
      signal,
      name === 'apply_force'
        ? 'Apply Force'
        : name === 'rotate_objects'
          ? 'Rotate Objects'
          : name === 'translate_objects'
            ? 'Move Objects'
            : 'Set Object Pose',
    );
  }
  dispose() {
    this.captureDispose?.();
    this.captureImage = undefined;
    this.buffer.delete();
    this.data.delete();
    this.history.delete();
    this.model.delete();
    World.removeDirectory(this.mj, this.directory);
    this.listeners.clear();
  }
}

export function errorCode(message: string) {
  return /cancelled/i.test(message)
    ? 'cancelled'
    : /running|Wait for/.test(message)
      ? 'busy'
      : /Unsupported capability/.test(message)
        ? 'unsupported_capability'
        : /ended/.test(message)
          ? 'episode_ended'
          : /disabled|Tool is disabled/.test(message)
            ? 'disabled'
            : /unstable|Non-finite/.test(message)
              ? 'unstable_physics'
              : /history|latest/.test(message)
                ? 'historical_edit'
                : 'invalid_argument';
}
