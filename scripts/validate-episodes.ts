/** Validate archives and load every model in the actual WASM runtime. */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import loadMujoco from '@mujoco/mujoco';
import { World } from '../src/runtime.ts';
import { decodeEpisode } from '../src/archive.ts';

let engine;
World.engine = () => (engine ??= loadMujoco());
async function collect(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? collect(join(directory, entry.name))
        : Promise.resolve(entry.name.endsWith('.episode.zip') ? [join(directory, entry.name)] : []),
    ),
  );
  return nested.flat().sort();
}
const directory = process.argv[2];
if (!directory)
  throw new Error('Usage: node --experimental-strip-types scripts/validate-episodes.ts DIRECTORY');
const files = await collect(directory);
const failures: { file: string; error: string }[] = [];
let objects = 0,
  frames = 0;
for (const path of files) {
  let world: World | undefined;
  try {
    const episode = await decodeEpisode(new File([await readFile(path)], path));
    world = await World.create(episode.assets, episode);
    for (const frame of [episode.initial, ...episode.states, ...episode.trajectory]) {
      world.restoreLive(frame);
      const restored = world.snapshot(frame.index);
      for (const key of Object.keys(restored) as (keyof typeof restored)[]) {
        if (!isDeepStrictEqual(restored[key], frame[key]))
          throw new Error(`Snapshot restore mismatch: ${key}`);
      }
      frames++;
    }
    objects += episode.manifest.objects.length;
  } catch (error) {
    failures.push({ file: path, error: String(error) });
  } finally {
    world?.dispose();
  }
}
console.log(
  JSON.stringify(
    { archives: files.length, passed: files.length - failures.length, objects, frames, failures },
    null,
    2,
  ),
);
if (!files.length || failures.length) process.exitCode = 1;
