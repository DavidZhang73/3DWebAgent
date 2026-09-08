import { test } from 'node:test';
import assert from 'node:assert/strict';
import loadMujoco from '@mujoco/mujoco';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { World } from '../src/runtime.ts';
import { decodeEpisode, encodeEpisode } from '../src/archive.ts';
import { parseOBJ, isPlanar } from '../src/objects.ts';
import { registerTools, diagnostics } from '../src/webmcp.ts';
let module;
World.engine = () => (module ??= loadMujoco());
const xml =
  '<mujoco><option timestep=".002"/><worldbody><geom name="ground" type="plane" size="5 5 .1"/><body name="a" pos="-1 0 1"><freejoint/><geom type="sphere" size=".1" mass="1"/></body><body name="b" pos="1 0 1"><freejoint/><geom type="box" size=".1 .1 .1" mass="1"/></body></worldbody></mujoco>';
const create = () => World.create({ 'model.xml': strToU8(xml) });
const file = (bytes) => new File([bytes], 'test.episode.zip');
test('MCP calls preserve arguments, queries, errors and state references across exports', async () => {
  const w = await create();
  let loaded;
  try {
    const input = { ids: ['a'], delta: [0, 1, 0] };
    await w.execute('translate_objects', input, 'webmcp');
    input.delta[1] = 99;
    await w.execute('get_state', {}, 'webmcp');
    await assert.rejects(w.execute('get_object', { id: 'missing' }, 'webmcp'), /Unknown/);
    assert.equal(w.episode.states.length, 1);
    assert.deepEqual(
      w.episode.calls.map((c) => [c.name, c.state_index, c.status]),
      [
        ['translate_objects', 1, 'completed'],
        ['get_state', 1, 'completed'],
        ['get_object', 1, 'error'],
      ],
    );
    assert.deepEqual(w.episode.calls[0].arguments.delta, [0, 1, 0]);
    assert.match(w.episode.calls[2].error, /Unknown/);
    const ep = await decodeEpisode(file(await encodeEpisode(w.episode)));
    assert.deepEqual(ep.calls, w.episode.calls);
    loaded = await World.create(ep.assets, ep);
    await loaded.execute('list_objects', {}, 'webmcp');
    assert.equal(loaded.episode.calls.at(-1).index, 3);
    const invalid = structuredClone(ep);
    invalid.calls[0].state_index = 999;
    await assert.rejects(encodeEpisode(invalid), /reference/);
  } finally {
    loaded?.dispose();
    w.dispose();
  }
});
test('manual setup stays initial; agent queries and captures record calls without state commits', async () => {
  const w = await create();
  try {
    await w.execute('translate_objects', { ids: ['a'], delta: [1, 0, 0] });
    assert.equal(w.recording, false);
    assert.equal(w.episode.initial.integration[1], 0);
    const before = structuredClone(w.episode.initial);
    await w.execute('translate_objects', { ids: ['a'], delta: [0, 1, 0] }, 'webmcp');
    assert.equal(w.episode.states.length, 1);
    assert.deepEqual(w.episode.initial, before);
    assert.equal(w.object('a').position[1], 1);
    w.captureImage = () =>
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
    for (const t of ['list_objects', 'get_state', 'get_scene', 'capture_scene'])
      await w.execute(t, {}, 'webmcp');
    assert.equal(w.episode.states.length, 1);
    await w.execute('set_object_pose', { id: 'a', position: [0, 2, 1] });
    assert.equal(w.episode.states.length, 2);
    assert.throws(() => w.configure(w.config), /locked/);
  } finally {
    w.dispose();
  }
});
test('free observation never changes the scene camera, exports or camera-relative operations', async () => {
  const w = await create();
  try {
    const initial = structuredClone(w.episode.initial);
    for (let i = 0; i < 140; i++)
      w.setViewCamera({ position: [0, -3 - i * 0.01, 0], target: [0, 0, 0] });
    assert.deepEqual(w.episode.initial, initial);
    assert.equal(w.editHistory.entries.length, 1);
    assert.equal(w.dirty, false);
    await w.updateCamera({ position: [0, -3, 0], target: [0, 0, 0] });
    assert.equal(w.editHistory.entries.length, 2);
    await w.execute('move_camera', { zoom: 0.8 }, 'webmcp');
    assert.equal(w.episode.states.length, 1);
    assert.equal(w.canUndo, false);
    const saved = JSON.stringify(w.episode),
      camera = structuredClone(w.camera);
    w.setCursor(0);
    w.setViewCamera({ position: [3, 0, 1], target: [0, 0, 0] });
    assert.equal(JSON.stringify(w.episode), saved);
    assert.deepEqual(w.camera, camera);
    const view = structuredClone(w.view.camera);
    w.setCursor(1);
    assert.deepEqual(w.view.camera, view);
    w.setCursor(null);
    await w.execute(
      'translate_objects',
      { ids: ['a'], delta: [0, 0, 0.5], space: 'camera' },
      'webmcp',
    );
    assert.equal(w.episode.states.length, 2);
    assert.ok(Math.abs(w.object('a').position[1] - 0.5) < 1e-12);
    assert.deepEqual(w.episode.states[1].camera, camera);
    await w.updateCamera({ position: [1, -4, 1], target: [0, 0, 0] });
    assert.equal(w.episode.states.length, 3);
    const before = w.snapshot(),
      controller = new AbortController();
    controller.abort();
    await assert.rejects(
      w.execute('move_camera', { yaw: 15 }, 'webmcp', controller.signal),
      /cancel/,
    );
    assert.deepEqual(w.snapshot(), before);
    const full = await decodeEpisode(file(await encodeEpisode(w.episode))),
      current = await decodeEpisode(file(await encodeEpisode(w.episode, w.currentFrame)));
    assert.deepEqual(full.states.at(-1).camera, w.camera);
    assert.deepEqual(current.initial.camera, w.camera);
  } finally {
    w.dispose();
  }
});
test('explicit IDs ignore selection; camera coordinates and group rotation are stable', async () => {
  const w = await create();
  try {
    w.selected = ['b'];
    w.camera = { position: [0, -3, 0], target: [0, 0, 0] };
    await w.execute(
      'translate_objects',
      { ids: ['a'], delta: [0, 0, 0.5], space: 'camera' },
      'webmcp',
    );
    assert.equal(w.object('a').position[1], 0.5);
    assert.equal(w.object('b').position[1], 0);
    await w.execute('group_objects', { ids: ['a', 'b'] }, 'webmcp');
    const dist = () =>
      Math.hypot(...w.object('a').position.map((v, i) => v - w.object('b').position[i]));
    const prior = dist();
    await w.execute('rotate_objects', { ids: [w.groups[0].id], angles: [0, 0, 90] }, 'webmcp');
    assert.ok(Math.abs(dist() - prior) < 1e-10);
    await w.execute('ungroup_objects', { ids: [w.groups[0].id] }, 'webmcp');
    assert.equal(w.groups.length, 0);
  } finally {
    w.dispose();
  }
});
test('failures start the episode, disabled tools remain disabled, historical edits are rejected', async () => {
  const w = await create();
  try {
    w.configure({ ...w.config, enabledTools: ['set_object_pose', 'get_state'] });
    const before = w.snapshot();
    await assert.rejects(
      w.execute(
        'set_object_pose',
        { id: 'a', position: [1, 2, 3], quaternion: [0, 0, 0, 0] },
        'webmcp',
      ),
      /zero/,
    );
    assert.deepEqual(w.snapshot(), before);
    assert.equal(w.recording, true);
    assert.throws(() => w.configure(w.config), /locked/);
    await assert.rejects(
      w.execute('translate_objects', { ids: ['a'], delta: [1, 0, 0] }, 'webmcp'),
      /disabled/,
    );
    await w.execute('translate_objects', { ids: ['a'], delta: [1, 0, 0] });
    assert.equal(w.episode.calls.at(-1).actor, 'human');
    const calls = w.episode.calls.length;
    w.setCursor(0);
    await assert.rejects(
      w.execute('translate_objects', { ids: ['a'], delta: [1, 0, 0] }),
      /latest/,
    );
    assert.equal(w.episode.calls.length, calls);
    assert.equal(w.episode.states.length, 1);
    await w.execute('set_object_pose', { id: 'a', position: [2, 0, 0] }, 'webmcp');
    assert.equal(w.episode.states.length, 2);
    assert.equal(w.cursor, 0);
    assert.equal(w.object('a').position[0], 2);
  } finally {
    w.dispose();
  }
});
test('minimal full and current exports restore exact states and append', async () => {
  const w = await create();
  let loaded;
  try {
    await w.execute('translate_objects', { ids: ['a'], delta: [1, 0, 0] }, 'webmcp');
    await w.execute('rotate_objects', { ids: ['b'], angles: [0, 45, 0] }, 'webmcp');
    const bytes = await encodeEpisode(w.episode),
      members = Object.keys(unzipSync(bytes));
    assert.deepEqual(members.sort(), [
      'calls.jsonl',
      'events.jsonl',
      'frames.bin',
      'frames.jsonl',
      'manifest.json',
      'world/model.xml',
    ]);
    const ep = await decodeEpisode(file(bytes));
    loaded = await World.create(ep.assets, ep);
    assert.deepEqual(loaded.snapshot(), w.snapshot());
    loaded.setCursor(0);
    assert.equal(loaded.object('a').position[0], 0);
    const zero = await decodeEpisode(
      file(await encodeEpisode(loaded.episode, loaded.currentFrame)),
    );
    assert.equal(zero.states.length, 0);
    assert.deepEqual(zero.initial, w.episode.initial);
    assert.deepEqual(zero.calls, []);
    assert.deepEqual(ep.calls, w.episode.calls);
    loaded.setCursor(null);
    await loaded.execute('translate_objects', { ids: ['b'], delta: [0, 0, 1] }, 'webmcp');
    assert.equal(loaded.episode.states.length, 3);
  } finally {
    loaded?.dispose();
    w.dispose();
  }
});
test('archives reject corruption, legacy fields and malformed state', async () => {
  const w = await create();
  try {
    const files = unzipSync(await encodeEpisode(w.episode));
    files['world/model.xml'] = strToU8('changed');
    await assert.rejects(decodeEpisode(file(zipSync(files))), /checksum/);
    const good = unzipSync(await encodeEpisode(w.episode));
    good['actions.jsonl'] = strToU8('');
    await assert.rejects(decodeEpisode(file(zipSync(good))), /Unexpected|checksum/);
    const ep = structuredClone(w.episode);
    ep.initial.integration[0] = NaN;
    await assert.rejects(encodeEpisode(ep), /Invalid/);
  } finally {
    w.dispose();
  }
});
test('physics disabled, fixed gravity and settling timeout use one state per operation', async () => {
  const w = await create();
  try {
    await w.execute('set_object_pose', { id: 'a', position: [0, 0, 2] });
    assert.equal(w.data.time, 0);
    w.configure({
      ...w.config,
      physics: { ...w.config.physics, enabled: true, duration: 0.1, detection: false },
    });
    await w.execute('set_object_pose', { id: 'a', position: [0, 0, 2] }, 'webmcp');
    assert.ok(w.object('a').position[2] < 2);
    assert.ok(w.data.time >= 0.1 - 1e-9);
    assert.equal(w.episode.states.length, 1);
  } finally {
    w.dispose();
  }
  const settle = await create();
  try {
    settle.configure({
      ...settle.config,
      physics: {
        ...settle.config.physics,
        enabled: true,
        strategy: 'settle',
        gravity: [0, 0, 0],
        maxDuration: 0.1,
        quietDuration: 0.02,
      },
    });
    const result = await settle.execute(
      'set_object_pose',
      { id: 'a', position: [0, 0, 1] },
      'webmcp',
    );
    assert.equal(result.physics, 'settled');
  } finally {
    settle.dispose();
  }
  const timeout = await create();
  try {
    timeout.configure({
      ...timeout.config,
      physics: {
        ...timeout.config.physics,
        enabled: true,
        strategy: 'settle',
        detection: false,
        maxDuration: 0.1,
        quietDuration: 0.02,
      },
    });
    const result = await timeout.execute(
      'set_object_pose',
      { id: 'a', position: [0, 0, 5] },
      'webmcp',
    );
    assert.equal(result.physics, 'timeout');
    assert.equal(timeout.episode.states.length, 1);
  } finally {
    timeout.dispose();
  }
});
test('collision detection and response are independent', async () => {
  for (const [detection, response] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    const w = await create();
    try {
      w.configure({
        ...w.config,
        physics: { ...w.config.physics, enabled: true, detection, response, duration: 0.5 },
      });
      await w.execute('set_object_pose', { id: 'a', position: [0, 0, 0.2] }, 'webmcp');
      if (response) assert.ok(w.object('a').position[2] > 0.07);
      else assert.ok(w.object('a').position[2] < 0);
      if (!detection) assert.deepEqual(w.contacts(), []);
    } finally {
      w.dispose();
    }
  }
  const w = await create();
  try {
    w.configure({
      ...w.config,
      physics: { ...w.config.physics, detection: true, response: false },
    });
    await w.execute('set_object_pose', { id: 'a', position: [0, 0, 0.05] });
    assert.ok(w.contacts().length > 0);
  } finally {
    w.dispose();
  }
});
test('OBJ splits declarations and keeps coordinates, negative indices and polygons', () => {
  const parts = parseOBJ(
    'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3\no piece\nf -4 -3 -2 -1\ng leg\nf 1 3 4',
  );
  assert.equal(parts.length, 3);
  assert.equal(parts[1].faces.length, 2);
  assert.deepEqual(parts[1].positions[0], [0, 0, 0]);
  assert.equal(parts[2].name, 'leg');
  assert.throws(() => parseOBJ('v 0 0 0\nf 1 2 3'), /index/);
});
test('native registration follows enabled tools and stale callbacks fail closed', async () => {
  const w = await create();
  const registered = new Map();
  globalThis.document = {
    modelContext: {
      registerTool(tool, { signal }) {
        registered.set(tool.name, tool);
        signal.addEventListener('abort', () => registered.delete(tool.name));
      },
      async getTools() {
        return [...registered.values()];
      },
    },
  };
  try {
    // A legacy archive may still list this retired capability.
    w.config.enabledTools.push('end_episode');
    await decodeEpisode(file(await encodeEpisode(w.episode)));
    const stop = registerTools(w, () => {});
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(registered.size, 13);
    assert.equal(registered.has('end_episode'), false);
    const old = registered.get('get_state');
    const result = JSON.parse(await old.execute({}));
    assert.equal(result.objects.length, 2);
    stop();
    assert.throws(() => w.configure({ ...w.config, enabledTools: ['list_objects'] }), /locked/);
    const fresh = await create();
    fresh.configure({ ...fresh.config, enabledTools: ['list_objects'] });
    const stop2 = registerTools(fresh, () => {});
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([...registered.keys()], ['list_objects']);
    assert.match(JSON.parse(await old.execute({})).error, /expired/);
    assert.deepEqual(diagnostics.native, ['list_objects']);
    await assert.rejects(fresh.execute('start_episode', {}, 'webmcp'), /Tool is disabled/);
    await assert.rejects(fresh.execute('end_episode', {}, 'webmcp'), /Invalid/);
    assert.notEqual(fresh.episode.manifest.lifecycle, 'ended');
    stop2();
    fresh.dispose();
  } finally {
    delete globalThis.document;
    w.dispose();
  }
});

test('planar detection preserves nonplanar solids and rejects degenerate surfaces', () => {
  assert.equal(
    isPlanar([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
    ]),
    true,
  );
  assert.equal(
    isPlanar([
      [0, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]),
    false,
  );
  assert.throws(
    () =>
      isPlanar([
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ]),
    /degenerate/,
  );
});
test('force state resumes exactly and cancellation rolls back', async () => {
  const w = await create();
  let restored;
  try {
    w.configure({
      ...w.config,
      enabledTools: [...w.config.enabledTools, 'apply_force'],
      physics: { ...w.config.physics, enabled: true, gravity: [0, 0, 0], duration: 0.02 },
    });
    const before = w.snapshot(),
      controller = new AbortController();
    controller.abort();
    await assert.rejects(
      w.execute('apply_force', { id: 'a', force: [1, 0, 0] }, 'webmcp', controller.signal),
      /cancelled/,
    );
    assert.deepEqual(w.snapshot(), before);
    assert.equal(w.recording, true);
    await w.execute('apply_force', { id: 'a', force: [1, 0, 0] }, 'webmcp');
    assert.ok(w.object('a').position[0] > -1);
    const ep = await decodeEpisode(file(await encodeEpisode(w.episode)));
    restored = await World.create(ep.assets, ep);
    for (const world of [w, restored])
      await world.execute('translate_objects', { ids: ['b'], delta: [0, 0, 0.1] }, 'webmcp');
    assert.deepEqual(restored.snapshot(), w.snapshot());
  } finally {
    restored?.dispose();
    w.dispose();
  }
});

test('setup edit history restores documents and cannot undo a running episode', async () => {
  let w = await create();
  const worlds = [w];
  try {
    w.renameObject('a', 'First');
    w.markSaved();
    w.setMetadata({ name: 'Experiment' });
    await w.execute('group_objects', { ids: ['a', 'b'], name: 'Pair' });
    assert.equal(w.editHistory.index, 3);
    w = await w.restoreEdit(1);
    worlds.push(w);
    assert.equal(w.object('a').name, 'First');
    assert.equal(w.episode.manifest.name, 'Untitled');
    assert.equal(w.groups.length, 0);
    assert.deepEqual(w.episode.calls, []);
    assert.equal(w.dirty, false);
    assert.equal(w.canRedo, true);
    w.markSaved();
    w = await w.restoreEdit(3);
    worlds.push(w);
    assert.equal(w.groups.length, 1);
    assert.equal(w.dirty, true);
    w = await w.restoreEdit(1);
    worlds.push(w);
    assert.equal(w.dirty, false);
    w.configure({ ...w.config, physics: { ...w.config.physics, gravity: [0, 0, -2] } });
    assert.equal(w.canRedo, false);
    const index = w.editHistory.index,
      before = w.snapshot();
    await assert.rejects(
      w.editPoses([{ id: 'a', position: [1, 2, 3], quaternion: [0, 0, 0, 0] }]),
      /zero/,
    );
    assert.equal(w.editHistory.index, index);
    assert.deepEqual(w.snapshot(), before);
    await assert.rejects(
      w.execute('translate_objects', { ids: ['missing'], delta: [0, 0, 1] }, 'webmcp'),
    );
    assert.equal(w.canUndo, false);
    await assert.rejects(w.restoreEdit(0), /unavailable/);
    await w.execute('translate_objects', { ids: ['a'], delta: [0, 0, 1] }, 'webmcp');
    assert.equal(w.editHistory.entries.length, 0);
    assert.equal(w.canUndo, false);
  } finally {
    worlds.forEach((w) => w.dispose());
  }
});

test('batched manual transforms advance physics once and create one history entry', async () => {
  const w = await create();
  try {
    w.configure({
      ...w.config,
      physics: { ...w.config.physics, enabled: true, detection: false, duration: 0.05 },
    });
    const before = w.editHistory.entries.length;
    await w.editPoses(
      ['a', 'b'].map((id, i) => ({ id, position: [i, 0, 2], quaternion: [1, 0, 0, 0] })),
    );
    assert.equal(w.editHistory.entries.length, before + 1);
    assert.equal(w.episode.states.length, 0);
    assert.ok(w.data.time < 0.052);
    await w.execute('group_objects', { ids: ['a', 'b'] }, 'webmcp');
    await w.editPoses(
      ['a', 'b'].map((id, i) => ({ id, position: [i, 0, 3], quaternion: [1, 0, 0, 0] })),
    );
    assert.equal(w.episode.states.length, 2);
    assert.ok(w.data.time < 0.104);
  } finally {
    w.dispose();
  }
});

test('per-object collision overrides round-trip without changing authored masks', async () => {
  const w = await create();
  let loaded;
  try {
    const assets = structuredClone(w.assets),
      g = w.object('a').geometries[0].index;
    w.setCollisionEnabled('a', false);
    assert.equal(w.model.geom_contype[g], 0);
    assert.deepEqual(w.assets, assets);
    const ep = await decodeEpisode(file(await encodeEpisode(w.episode)));
    loaded = await World.create(ep.assets, ep);
    assert.equal(loaded.model.geom_contype[g], 0);
    loaded.setCollisionEnabled('a', true);
    assert.equal(loaded.model.geom_contype[g], 1);
    loaded.configure({ ...loaded.config, physics: { ...loaded.config.physics, detection: false } });
    assert.equal(loaded.model.geom_contype[g], 0);
    loaded.configure({ ...loaded.config, physics: { ...loaded.config.physics, detection: true } });
    assert.equal(loaded.model.geom_contype[g], 1);
  } finally {
    loaded?.dispose();
    w.dispose();
  }
  const noCollider = await World.create({
    'model.xml': strToU8(xml.replace('mass="1"', 'mass="1" contype="0" conaffinity="0"')),
  });
  try {
    assert.throws(() => noCollider.setCollisionEnabled('a', true), /no collision/);
  } finally {
    noCollider.dispose();
  }
  const pairXML = xml
    .replace('size=".1" mass="1"', 'size=".1" mass="1" name="ga"')
    .replace('size=".1 .1 .1" mass="1"', 'size=".1 .1 .1" mass="1" name="gb"')
    .replace('</mujoco>', '<contact><pair geom1="ga" geom2="gb"/></contact></mujoco>');
  const paired = await World.create({ 'model.xml': strToU8(pairXML) });
  try {
    assert.throws(() => paired.setCollisionEnabled('a', false), /explicit contact/i);
  } finally {
    paired.dispose();
  }
});

test('history rendering restores each selected frame once across free-view notifications', async () => {
  const w = await create();
  try {
    await w.execute('translate_objects', { ids: ['a'], delta: [0, 1, 0] }, 'webmcp');
    const restore = w.restore.bind(w);
    let restores = 0;
    w.restore = (data, frame) => {
      if (data === w.history) restores++;
      restore(data, frame);
    };
    w.setCursor(0);
    w.viewedData();
    w.setViewCamera({ position: [3, -4, 2], target: [0, 0, 0] });
    for (let i = 0; i < 10; i++) w.viewedData();
    assert.equal(restores, 1);
    w.setCursor(1);
    const moved = Array.from(w.viewedData().geom_xpos);
    assert.equal(restores, 2);
    w.setCursor(0);
    assert.notDeepEqual(Array.from(w.viewedData().geom_xpos), moved);
    assert.equal(restores, 3);
    w.setTraceCursor(0);
    w.viewedData();
    w.viewedData();
    assert.equal(restores, 4);
  } finally {
    w.dispose();
  }
});
