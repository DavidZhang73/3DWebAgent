import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import loadMujoco from '@mujoco/mujoco';
import { World } from '../src/runtime.ts';
import { encodeEpisode, decodeEpisode, validateEpisode, asInitial } from '../src/archive.ts';
import { verifyEpisode } from '../src/verify.ts';
import fixture from '../schema/conformance.json' with { type: 'json' };
let engine;
World.engine = () => (engine ??= loadMujoco());
const xml =
  '<mujoco><option timestep=".002"/><worldbody><geom type="plane" size="5 5 .1"/><body name="a" pos="0 0 .4"><freejoint/><geom type="sphere" size=".1" mass="1"/></body><body name="b" pos="1 0 .4"><freejoint/><geom type="box" size=".1 .1 .1" mass="1"/></body></worldbody></mujoco>';
const create = () => World.create({ 'model.xml': new TextEncoder().encode(xml) });
const python = (...args: string[]) =>
  JSON.parse(
    execFileSync(
      process.env.EPISODE_PYTHON ?? 'python/.venv/bin/python',
      ['python/replay.py', ...args],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    ),
  );
const open = async (path: string) =>
  decodeEpisode(new File([new Uint8Array(await readFile(path))], path));
test('lifecycle starts on observation, freezes setup, ends idempotently, and exports fresh setup', async () => {
  const w = await create();
  try {
    await w.execute('get_state', {}, 'webmcp');
    assert.equal(w.episode.manifest.lifecycle, 'active');
    assert.equal(w.episode.states.length, 0);
    assert.equal(w.canUndo, false);
    assert.throws(() => w.renameObject('a', 'Changed'), /locked/);
    await w.execute('end_episode', { reason: 'budget' }, 'webmcp');
    const count = w.episode.calls.length;
    assert.deepEqual(await w.execute('end_episode', {}, 'webmcp'), {
      status: 'ended',
      reason: 'budget',
    });
    assert.equal(w.episode.calls.length, count);
    await assert.rejects(
      w.execute('translate_objects', { ids: ['a'], delta: [1, 0, 0] }, 'webmcp'),
      /ended/,
    );
    const initial = asInitial(w.episode, w.snapshot());
    assert.equal(initial.manifest.lifecycle, 'setup');
    assert.equal(initial.calls.length, 0);
    assert.notEqual(initial.manifest.id, w.episode.manifest.id);
    validateEpisode(initial);
  } finally {
    w.dispose();
  }
});
test('cancellation keeps partial attempt and rollback; a concurrent rejection has independent events', async () => {
  const w = await create();
  try {
    w.configure({ ...w.config, physics: { ...w.config.physics, enabled: true, duration: 0.02 } });
    w.cancelAtStep = 3;
    const before = w.snapshot();
    await assert.rejects(
      w.execute('advance_simulation', { duration: 0.02 }, 'webmcp'),
      /cancelled/,
    );
    assert.deepEqual(w.snapshot(), before);
    assert.equal(w.episode.trajectory.filter((f) => f.phase === 'physics').length, 3);
    assert.equal(w.episode.trajectory.at(-1).phase, 'rollback');
    assert.equal((await verifyEpisode(w.episode)).status, 'passed');
    w.cancelAtStep = undefined;
    const run = w.execute('advance_simulation', { duration: 0.02 }, 'webmcp');
    await assert.rejects(w.execute('get_state', {}, 'webmcp'), /running/);
    await run;
    assert.equal(w.episode.calls.at(-1).error_code, 'busy');
    validateEpisode(w.episode);
    const replay = await verifyEpisode(w.episode);
    assert.equal(replay.status, 'passed', JSON.stringify(replay));
  } finally {
    w.dispose();
  }
});
test('WASM and native run, restore, verify and continue the same episode in both directions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portable-episode-'));
  const w = await create();
  let native;
  try {
    w.configure({
      ...w.config,
      enabledTools: [...w.config.enabledTools, 'apply_force'],
      physics: { ...w.config.physics, enabled: true, duration: 0.02 },
    });
    const setup = join(dir, 'setup.zip'),
      wasm = join(dir, 'wasm.zip'),
      commands = join(dir, 'commands.jsonl'),
      nativePath = join(dir, 'native.zip');
    await writeFile(setup, await encodeEpisode(w.episode));
    await writeFile(commands, fixture.commands.map((c) => JSON.stringify(c)).join('\n'));
    for (const c of fixture.commands) {
      w.cancelAtStep = c.cancel_at_step;
      try {
        await w.executeRecorded(c.name, c.arguments, c.actor === 'human' ? 'manual' : 'webmcp');
      } catch (e) {
        if (!c.cancel_at_step && c.name !== 'set_object_pose') throw e;
      }
    }
    w.cancelAtStep = undefined;
    await writeFile(wasm, await encodeEpisode(w.episode));
    const same = await verifyEpisode(w.episode);
    assert.equal(same.status, 'passed', JSON.stringify(same));
    assert.equal(same.exact, true);
    const cross = python(
      'verify',
      wasm,
      '--atol',
      String(fixture.atol),
      '--rtol',
      String(fixture.rtol),
    );
    assert.equal(cross.status, 'passed');
    assert.equal(
      python(
        'verify',
        wasm,
        '--mode',
        'operation',
        '--atol',
        String(fixture.atol),
        '--rtol',
        String(fixture.rtol),
      ).status,
      'passed',
    );
    assert.equal(python('inspect', wasm).max_restore_error, 0);
    assert.equal(python('run', setup, commands, '-o', nativePath).status, 'passed');
    assert.equal(python('verify', nativePath).exact, true);
    const ep = await open(nativePath);
    native = await World.create(ep.assets, ep);
    const reverse = await verifyEpisode(ep, { atol: fixture.atol, rtol: fixture.rtol });
    assert.equal(reverse.status, 'passed', JSON.stringify(reverse));
    await native.execute('advance_simulation', { duration: 0.02 }, 'webmcp');
    assert.equal(native.episode.calls.at(-1).producer.backend, 'wasm');
    const continuation = join(dir, 'continuation.jsonl');
    await writeFile(
      continuation,
      JSON.stringify({ name: 'advance_simulation', arguments: { duration: 0.02 } }),
    );
    assert.equal(python('run', wasm, continuation, '-o', nativePath).status, 'passed');
    const continued = await open(nativePath);
    assert.equal(continued.calls.at(-1).producer.backend, 'native');
    assert.deepEqual(continued.calls.slice(0, -1), w.episode.calls);
    const modified = structuredClone(w.episode);
    modified.trajectory.find((f) => f.phase === 'physics').integration[1] += 0.01;
    assert.equal((await verifyEpisode(modified)).status, 'diverged');
  } finally {
    w.dispose();
    native?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
test('native and WASM each retain 30000 physical steps and round-trip Float64 state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'episode-long-'));
  const w = await create();
  try {
    w.configure({
      ...w.config,
      physics: { ...w.config.physics, enabled: true, gravity: [0, 0, 0], detection: false },
    });
    const setup = join(dir, 'setup.zip'),
      output = join(dir, 'native.zip'),
      commands = join(dir, 'commands.jsonl');
    await writeFile(setup, await encodeEpisode(w.episode));
    await writeFile(
      commands,
      JSON.stringify({ name: 'advance_simulation', arguments: { duration: 60 } }),
    );
    await w.execute('advance_simulation', { duration: 60 }, 'webmcp');
    assert.equal(w.episode.calls[0].steps, 30000);
    const ep = await decodeEpisode(
      new File([new Uint8Array(await encodeEpisode(w.episode))], 'long.zip'),
    );
    assert.equal(ep.trajectory.filter((f) => f.phase === 'physics').length, 30000);
    assert.deepEqual(ep.states.at(-1), w.snapshot());
    w.setTraceCursor(15000);
    assert.equal(w.currentFrame.step, 15000);
    w.setCursor(null);
    assert.equal(python('run', setup, commands, '-o', output).status, 'passed');
    assert.equal(python('inspect', output).physics_frames, 30000);
    const native = await open(output);
    assert.equal(native.trajectory.filter((f) => f.phase === 'physics').length, 30000);
  } finally {
    w.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test('shared physics fixtures agree on settling, timeout and collision overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'episode-policies-'));
  try {
    for (const policy of fixture.physicsCases) {
      const w = await create();
      try {
        w.configure({
          ...w.config,
          physics: {
            ...w.config.physics,
            enabled: true,
            duration: 0.02,
            ...policy.physics,
            strategy: policy.physics.strategy === 'settle' ? 'settle' : 'fixed',
          },
        });
        if (policy.collisionEnabled === false) w.setCollisionEnabled('a', false);
        const setup = join(dir, 'setup.zip'),
          archive = join(dir, 'wasm.zip'),
          native = join(dir, 'native.zip'),
          commands = join(dir, 'commands.jsonl');
        const command = {
          name: 'translate_objects',
          arguments: {
            ids: ['a'],
            delta: [0, 0, policy.physics.strategy === 'settle' ? 0.01 : -0.31],
          },
        };
        await writeFile(setup, await encodeEpisode(w.episode));
        await writeFile(
          commands,
          JSON.stringify(command) + '\n' + JSON.stringify({ name: 'get_state', arguments: {} }),
        );
        const result = (await w.execute('translate_objects', command.arguments, 'webmcp')) as {
          physics: string;
          steps: number;
        };
        assert.equal(result.physics, policy.stop, policy.name);
        assert.equal(result.steps, policy.steps, policy.name);
        await w.execute('get_state', {}, 'webmcp');
        await writeFile(archive, await encodeEpisode(w.episode));
        assert.equal((await verifyEpisode(w.episode)).status, 'passed');
        assert.equal(
          python('verify', archive, '--atol', String(fixture.atol), '--rtol', String(fixture.rtol))
            .status,
          'passed',
          policy.name,
        );
        python('run', setup, commands, '-o', native);
        assert.equal(python('verify', native).exact, true);
        const report = await verifyEpisode(await open(native), {
          atol: fixture.atol,
          rtol: fixture.rtol,
        });
        assert.equal(report.status, 'passed', JSON.stringify(report));
      } finally {
        w.dispose();
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
