import { test } from 'node:test';
import assert from 'node:assert/strict';
import loadMujoco from '@mujoco/mujoco';
import { strToU8 } from 'fflate';
import { World } from '../src/runtime.ts';
import { decodeEpisode, encodeEpisode } from '../src/archive.ts';
import { importOBJ, removeObjects, editObject } from '../src/objects.ts';

let module;
World.engine = () => (module ??= loadMujoco());
const xml =
  '<mujoco><worldbody><body name="a"><freejoint/><geom type="box" size=".1 .2 .3"/></body><body name="b" pos="1 0 0"><freejoint/><geom type="sphere" size=".1"/></body></worldbody></mujoco>';

async function binaryEpisode() {
  const w = await World.create({ 'model.xml': strToU8(xml) });
  try {
    w.mj.mj_saveModel(w.model, '/fixture.mjb', null);
    const bytes = w.mj.FS.readFile('/fixture.mjb');
    w.mj.FS.unlink('/fixture.mjb');
    const ep = structuredClone(w.episode);
    ep.manifest.model = { format: 'mjb', path: 'model.mjb' };
    ep.assets = { 'model.mjb': bytes };
    return ep;
  } finally {
    w.dispose();
  }
}

test('v1 MJB supports fixed-part operations, roundtrip and cleanup', async () => {
  const ep = await binaryEpisode();
  const bytes = ep.assets['model.mjb'].slice();
  const w = await World.create(ep.assets, ep);
  let loaded;
  try {
    assert.equal(w.episode.manifest.version, 1);
    assert.equal(w.canEditModel, false);
    const before = JSON.stringify(w.episode);
    await assert.rejects(importOBJ(w, []), /fixed parts/);
    await assert.rejects(removeObjects(w, ['a']), /fixed parts/);
    await assert.rejects(editObject(w, 'a', { mass: 2 }), /fixed parts/);
    assert.equal(JSON.stringify(w.episode), before);
    await w.execute('translate_objects', { ids: ['a'], delta: [0, 1, 0] }, 'webmcp');
    await w.execute('group_objects', { ids: ['a', 'b'] }, 'webmcp');
    await w.execute('get_scene', {}, 'webmcp');
    const decoded = await decodeEpisode(new File([await encodeEpisode(w.episode)], 'mjb.zip'));
    assert.deepEqual(decoded.assets['model.mjb'], bytes);
    loaded = await World.create(decoded.assets, decoded);
    assert.deepEqual(loaded.snapshot(), w.snapshot());
    assert.deepEqual(decoded.calls, w.episode.calls);
    assert.equal(loaded.mj.FS.readdir(loaded.directory).length, 2);
  } finally {
    loaded?.dispose();
    w.dispose();
  }
});

test('MJB descriptors, missing files, corrupt binaries and incompatible states fail', async () => {
  const original = await binaryEpisode();
  for (const modify of [
    (ep) => {
      ep.manifest.model.path = '../outside.mjb';
    },
    (ep) => {
      ep.manifest.model.format = 'unknown';
    },
    (ep) => {
      delete ep.assets['model.mjb'];
    },
    (ep) => {
      ep.assets['model.mjb'] = strToU8('invalid');
    },
    (ep) => {
      ep.manifest.engine = '0.0.0';
    },
    (ep) => {
      ep.manifest.stateSize++;
    },
  ]) {
    const ep = structuredClone(original);
    modify(ep);
    await assert.rejects(World.create(ep.assets, ep));
  }
});
