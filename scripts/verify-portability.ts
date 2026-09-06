/** Produce a reviewable WASM -> native -> WASM episode and verification evidence. */
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import loadMujoco from '@mujoco/mujoco';
import { World } from '../src/runtime.ts';
import { encodeEpisode, decodeEpisode } from '../src/archive.ts';
import { verifyEpisode } from '../src/verify.ts';
import fixture from '../schema/conformance.json' with { type: 'json' };
let engine;
World.engine = () => (engine ??= loadMujoco());
const native = (...args: string[]) =>
  JSON.parse(
    execFileSync(
      process.env.EPISODE_PYTHON ?? 'python/.venv/bin/python',
      ['python/replay.py', ...args],
      { encoding: 'utf8' },
    ),
  );
const dir = await mkdtemp(join(tmpdir(), 'portable-evidence-'));
await mkdir('examples', { recursive: true });
const xml =
  '<mujoco><option timestep=".002"/><worldbody><geom type="plane" size="5 5 .1"/><body name="a" pos="0 0 .4"><freejoint/><geom type="sphere" size=".1" mass="1"/></body><body name="b" pos="1 0 .4"><freejoint/><geom type="box" size=".1 .1 .1" mass="1"/></body></worldbody></mujoco>';
const world = await World.create({ 'model.xml': new TextEncoder().encode(xml) });
let resumed: World | undefined;
try {
  world.setMetadata({ name: 'Portable physics and human intervention' });
  world.configure({
    ...world.config,
    enabledTools: [...world.config.enabledTools, 'apply_force'],
    physics: { ...world.config.physics, enabled: true, duration: 0.02 },
  });
  const setup = join(dir, 'setup.zip'),
    wasm = join(dir, 'wasm.zip'),
    nativeArchive = join(dir, 'native.zip'),
    commands = join(dir, 'commands.jsonl');
  await writeFile(setup, await encodeEpisode(world.episode));
  for (const command of fixture.commands) {
    world.cancelAtStep = command.cancel_at_step;
    try {
      await world.executeRecorded(
        command.name,
        command.arguments,
        command.actor === 'human' ? 'manual' : 'webmcp',
      );
    } catch (error) {
      if (!command.cancel_at_step && command.name !== 'set_object_pose') throw error;
    }
  }
  await writeFile(wasm, await encodeEpisode(world.episode));
  const wasmExact = await verifyEpisode(world.episode);
  await writeFile(commands, fixture.commands.map((c) => JSON.stringify(c)).join('\n'));
  native('run', setup, commands, '-o', nativeArchive);
  const nativeExact = native('verify', nativeArchive);
  const nativeCross = native(
    'verify',
    wasm,
    '--atol',
    String(fixture.atol),
    '--rtol',
    String(fixture.rtol),
  );
  const operationCross = native(
    'verify',
    wasm,
    '--mode',
    'operation',
    '--atol',
    String(fixture.atol),
    '--rtol',
    String(fixture.rtol),
  );
  await writeFile(
    commands,
    [
      {
        name: 'edit_poses',
        actor: 'human',
        arguments: {
          poses: [
            { id: 'a', position: [0, 0, 0.3], quaternion: [1, 0, 0, 0] },
            { id: 'b', position: [1, 0, 0.3], quaternion: [1, 0, 0, 0] },
          ],
        },
      },
      { name: 'advance_simulation', arguments: { duration: 0.04 } },
    ]
      .map((c) => JSON.stringify(c))
      .join('\n'),
  );
  native('run', wasm, commands, '-o', nativeArchive);
  const ep = await decodeEpisode(
    new File([new Uint8Array(await readFile(nativeArchive))], 'native.zip'),
  );
  resumed = await World.create(ep.assets, ep);
  assert.deepEqual(resumed.snapshot(), ep.states.at(-1));
  await resumed.execute('get_state', {}, 'webmcp');
  const output = 'examples/portable-physics.episode.zip';
  await writeFile(output, await encodeEpisode(resumed.episode));
  const browserCross = await verifyEpisode(resumed.episode, {
    atol: fixture.atol,
    rtol: fixture.rtol,
  });
  const finalNative = native(
    'verify',
    output,
    '--atol',
    String(fixture.atol),
    '--rtol',
    String(fixture.rtol),
  );
  const restore = native('inspect', output);
  const report = {
    generatedAt: new Date().toISOString(),
    archive: output,
    fixture: 'schema/conformance.json',
    wasmExact,
    nativeExact,
    nativeCross,
    operationCross,
    browserCross,
    finalNative,
    restore,
  };
  for (const r of [
    wasmExact,
    nativeExact,
    nativeCross,
    operationCross,
    browserCross,
    finalNative,
    restore,
  ])
    assert.equal(r.status, 'passed', JSON.stringify(r));
  assert.equal(wasmExact.exact, true);
  assert.equal(nativeExact.exact, true);
  await writeFile(
    'examples/portable-physics.verification.json',
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      archive: output,
      calls: resumed.episode.calls.length,
      physicsFrames: restore.physics_frames,
      status: 'passed',
    }),
  );
} finally {
  world.dispose();
  resumed?.dispose();
  await rm(dir, { recursive: true, force: true });
}
