import Ajv from 'ajv';
import schema from '../schema/episode.schema.json' with { type: 'json' };
import resultsSchema from '../schema/results.schema.json' with { type: 'json' };
const validator = new Ajv({ strict: false }).compile(schema);
const resultValidator = new Ajv({ strict: false }).compile(resultsSchema);
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import type { Assets, Episode, Frame, Manifest, RuntimeConfig } from './types.ts';
import { TOOL_NAMES } from './types.ts';
// Retired names remain readable in archives, but are never registered or executed.
const ARCHIVE_TOOL_NAMES: readonly string[] = [...TOOL_NAMES, 'end_episode'];
export function safePath(path: string) {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.includes(':') ||
    path.split('/').some((p) => !p || p === '..' || p === '.')
  )
    throw new Error('Unsafe asset path: ' + path);
  return path;
}
export async function hashes(assets: Assets): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(assets).map(async ([p, bytes]) => [
        p,
        Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)),
          (b) => b.toString(16).padStart(2, '0'),
        ).join(''),
      ]),
    ),
  );
}
const finiteVector = (v: unknown, n: number): v is number[] =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
export function validateRuntime(r: RuntimeConfig) {
  if (
    !r ||
    !Array.isArray(r.enabledTools) ||
    new Set(r.enabledTools).size !== r.enabledTools.length ||
    r.enabledTools.some((t) => !ARCHIVE_TOOL_NAMES.includes(t))
  )
    throw new Error('Invalid enabled tools.');
  const p = r.physics;
  if (
    !p ||
    !['enabled', 'detection', 'response'].every(
      (k) => typeof p[k as keyof typeof p] === 'boolean',
    ) ||
    !finiteVector(p.gravity, 3) ||
    !['fixed', 'settle'].includes(p.strategy)
  )
    throw new Error('Invalid physics configuration.');
  for (const k of [
    'duration',
    'maxDuration',
    'quietDuration',
    'linearThreshold',
    'angularThreshold',
  ] as const)
    if (!Number.isFinite(p[k]) || p[k] <= 0 || p[k] > 60)
      throw new Error('Invalid physics ' + k + ': expected (0,60].');
  if (p.quietDuration > p.maxDuration) throw new Error('Quiet duration exceeds timeout.');
}
export function validateFrame(f: Frame, m: Manifest) {
  if (
    !f ||
    !Number.isInteger(f.index) ||
    f.index < 0 ||
    !finiteVector(f.integration, m.stateSize) ||
    !f.camera ||
    !finiteVector(f.camera.position, 3) ||
    !finiteVector(f.camera.target, 3) ||
    Math.hypot(...f.camera.position.map((x, i) => x - f.camera.target[i])) < 0.001
  )
    throw new Error('Invalid state or camera.');
  const objects = new Set(m.objects.map((o) => o.id));
  if (!Array.isArray(f.groups)) throw new Error('Invalid groups.');
  const members = new Set<string>(),
    groups = new Set<string>();
  for (const g of f.groups) {
    if (
      !g.id ||
      objects.has(g.id) ||
      groups.has(g.id) ||
      typeof g.name !== 'string' ||
      !Array.isArray(g.members) ||
      g.members.length < 2
    )
      throw new Error('Invalid group.');
    groups.add(g.id);
    for (const id of g.members) {
      if (!objects.has(id) || members.has(id))
        throw new Error('Invalid or overlapping group membership.');
      members.add(id);
    }
  }
}
export function validateEpisode(ep: Episode) {
  const { assets, observations, ...logical } = ep;
  if (!validator(logical))
    throw new Error('Invalid episode schema: ' + JSON.stringify(validator.errors));
  const m = ep.manifest;
  if (
    !m ||
    m.format !== '3dwebagent-episode' ||
    m.version !== 1 ||
    m.engine !== '3.12.0' ||
    !['SI', 'normalized'].includes(m.units) ||
    typeof m.name !== 'string' ||
    !Number.isInteger(m.stateSpec) ||
    !Number.isInteger(m.stateSize) ||
    m.stateSize < 1
  )
    throw new Error('Unsupported episode. Only format 1 / MuJoCo 3.12.0 is supported.');
  validateRuntime(m.runtime);
  if (
    !Array.isArray(m.objects) ||
    m.objects.some((o) => !o.id || o.type !== 'rigid' || typeof o.name !== 'string') ||
    new Set(m.objects.map((o) => o.id)).size !== m.objects.length
  )
    throw new Error('Invalid object catalog.');
  const modelPath = m.model?.path ?? 'model.xml';
  if (!ep.assets[modelPath]) throw new Error('Missing world/' + modelPath + '.');
  Object.keys(ep.assets).forEach(safePath);
  if (!Array.isArray(ep.states)) throw new Error('Invalid timeline.');
  [ep.initial, ...ep.states].forEach((f, i) => {
    validateFrame(f, m);
    if (f.index !== i) throw new Error('State indices must be contiguous from zero.');
  });
  for (const [i, call] of (ep.calls ?? []).entries()) {
    if (
      call.index !== i ||
      call.state_index > ep.states.length ||
      ![...ARCHIVE_TOOL_NAMES, 'edit_poses', 'set_camera'].includes(call.name) ||
      !Number.isFinite(Date.parse(call.timestamp))
    )
      throw new Error('Invalid MCP call reference or timestamp.');
    if (call.status === 'completed' && !resultValidator({ name: call.name, result: call.result }))
      throw new Error('Invalid logical result: ' + JSON.stringify(resultValidator.errors));
    if ((call.status === 'error') !== (typeof call.error === 'string'))
      throw new Error('Invalid MCP call error status.');
  }
  for (const [key, bytes] of Object.entries(ep.observations))
    if (
      !/^[a-f0-9]{64}\.png$/.test(key) ||
      bytes.length < 24 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
    )
      throw new Error('Invalid PNG observation.');
  const checkObservation = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    const object = value as Record<string, unknown>;
    if (
      object.type === 'image' &&
      typeof object.observation === 'string' &&
      !ep.observations[object.observation]
    )
      throw new Error('Missing observation reference.');
    Object.values(object).forEach(checkObservation);
  };
  for (const c of ep.calls ?? []) checkObservation(c.result);
  const calls = ep.calls ?? [],
    ids = new Set(calls.map((c) => c.id));
  if (ids.size !== calls.length) throw new Error('Duplicate call ID.');
  for (const c of calls) {
    if (
      c.before_index > ep.states.length ||
      c.trace_end < c.trace_start ||
      c.trace_end > ep.trajectory.length
    )
      throw new Error('Invalid call range.');
  }
  const owners = new Map(calls.map((c) => [c.id, c]));
  ep.trajectory.forEach((f, i) => {
    validateFrame(f, m);
    const owner = owners.get(f.call_id);
    if (f.index !== i || !owner || i < owner.trace_start || i >= owner.trace_end)
      throw new Error('Invalid trajectory reference.');
  });
  ep.events.forEach((e, i) => {
    if (e.index !== i || !ids.has(e.call_id) || !Number.isFinite(Date.parse(e.timestamp)))
      throw new Error('Invalid event.');
  });
  for (const c of calls) {
    const events = ep.events.filter((e) => e.call_id === c.id);
    if (events.length !== 2 || events[0].kind !== 'request' || events[1].kind !== 'complete')
      throw new Error('Incomplete call events.');
    for (const f of ep.trajectory.slice(c.trace_start, c.trace_end))
      if (f.call_id !== c.id) throw new Error('Invalid call trajectory.');
  }
  if (
    m.lifecycle === 'setup' &&
    (calls.length || ep.states.length || ep.trajectory.length || ep.events.length)
  )
    throw new Error('Setup contains run history.');
  if ((m.lifecycle === 'ended') !== !!m.end) throw new Error('Invalid lifecycle end.');
}
export function asInitial(ep: Episode, current: Frame = ep.initial): Episode {
  const manifest = structuredClone(ep.manifest);
  manifest.id = crypto.randomUUID();
  manifest.lifecycle = 'setup';
  manifest.originTime = current.integration[0];
  manifest.hashes = {};
  delete manifest.end;
  delete manifest.task;
  return {
    manifest,
    assets: ep.assets,
    initial: { ...structuredClone(current), index: 0 },
    states: [],
    calls: [],
    events: [],
    trajectory: [],
    observations: {},
    revision: 0,
  };
}
export async function encodeEpisode(original: Episode, current?: Frame) {
  const ep = current ? asInitial(original, current) : original;
  validateEpisode(ep);
  const snapshotManifest = structuredClone(ep.manifest);
  const files: Assets = {};
  const rows = [
    { kind: 'initial', frame: ep.initial },
    ...ep.states.map((frame) => ({ kind: 'state', frame })),
    ...ep.trajectory.map((frame) => ({ kind: 'trace', frame })),
  ];
  const bytes = new Uint8Array(rows.length * ep.manifest.stateSize * 8),
    view = new DataView(bytes.buffer);
  const metadata = rows.map(({ kind, frame }, i) => {
    frame.integration.forEach((v, j) =>
      view.setFloat64((i * ep.manifest.stateSize + j) * 8, v, true),
    );
    const { integration, ...rest } = frame;
    return { kind, ...rest };
  });
  files['frames.bin'] = bytes;
  files['frames.jsonl'] = strToU8(metadata.map((row) => JSON.stringify(row)).join('\n'));
  files['events.jsonl'] = strToU8(ep.events.map((e) => JSON.stringify(e)).join('\n'));
  files['calls.jsonl'] = strToU8((ep.calls ?? []).map((c) => JSON.stringify(c)).join('\n'));
  for (const [p, b] of Object.entries(ep.assets)) files['world/' + safePath(p)] = b;
  for (const [p, b] of Object.entries(ep.observations)) files['observations/' + safePath(p)] = b;
  const manifest = { ...snapshotManifest, hashes: await hashes(files) };
  files['manifest.json'] = strToU8(JSON.stringify(manifest));
  return zipSync(files);
}
export async function decodeEpisode(file: File): Promise<Episode> {
  const members = new Set<string>();
  const files = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (entry) => {
      if (members.has(entry.name)) throw new Error('Duplicate archive member.');
      members.add(entry.name);
      return true;
    },
  });
  for (const p of Object.keys(files)) safePath(p);
  const read = (p: string) => {
    if (!files[p]) throw new Error('Missing ' + p);
    return strFromU8(files[p]);
  };
  const manifest = JSON.parse(read('manifest.json')) as Manifest;
  const payload = Object.fromEntries(Object.entries(files).filter(([p]) => p !== 'manifest.json'));
  const actual = await hashes(payload);
  if (
    JSON.stringify(Object.entries(actual).sort()) !==
    JSON.stringify(Object.entries(manifest.hashes ?? {}).sort())
  )
    throw new Error('Archive checksum mismatch.');
  const assets: Assets = {},
    observations: Assets = {};
  for (const [p, b] of Object.entries(payload)) {
    if (p.startsWith('world/')) assets[p.slice(6)] = b;
    else if (p.startsWith('observations/')) {
      const key = p.slice(13);
      if (
        !/^[a-f0-9]{64}\.png$/.test(key) ||
        (await hashes({ image: b })).image !== key.slice(0, -4)
      )
        throw new Error('Invalid observation hash.');
      observations[key] = b;
    } else if (!['frames.bin', 'frames.jsonl', 'events.jsonl', 'calls.jsonl'].includes(p))
      throw new Error('Unexpected archive member: ' + p);
  }
  const lines = (p: string) =>
    read(p)
      .split('\n')
      .filter(Boolean)
      .map((s) => JSON.parse(s));
  const rows = lines('frames.jsonl'),
    bytes = files['frames.bin'];
  if (
    !Number.isInteger(manifest.stateSize) ||
    manifest.stateSize < 1 ||
    !bytes ||
    bytes.length !== rows.length * manifest.stateSize * 8
  )
    throw new Error('Invalid state layout.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ep: Episode = {
    manifest,
    assets,
    observations,
    initial: null!,
    states: [],
    calls: lines('calls.jsonl'),
    events: lines('events.jsonl'),
    trajectory: [],
    revision: 0,
  };
  rows.forEach((row, i) => {
    const { kind, ...metadata } = row;
    const frame = {
      ...metadata,
      integration: Array.from({ length: manifest.stateSize }, (_, j) =>
        view.getFloat64((i * manifest.stateSize + j) * 8, true),
      ),
    };
    if (kind === 'initial' && i === 0) ep.initial = frame as Frame;
    else if (kind === 'state') ep.states.push(frame as Frame);
    else if (kind === 'trace') ep.trajectory.push(frame as Episode['trajectory'][number]);
    else throw new Error('Invalid frame kind.');
  });
  validateEpisode(ep);
  return ep;
}
