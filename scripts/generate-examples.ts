import { mkdir, writeFile } from 'node:fs/promises';
import loadMujoco from '@mujoco/mujoco';
import { World } from '../src/runtime.ts';
import { encodeEpisode } from '../src/archive.ts';
World.engine = () => loadMujoco();
await mkdir('examples', { recursive: true });
const xml =
  '<mujoco><option timestep=".002"/><worldbody><geom type="plane" size="5 5 .1"/><body name="a" pos="-1 0 1"><freejoint/><geom type="sphere" size=".1" mass="1"/></body><body name="b" pos="1 0 1"><freejoint/><geom type="box" size=".1 .1 .1" mass="1"/></body></worldbody></mujoco>';
const w = await World.create({ 'model.xml': new TextEncoder().encode(xml) });
try {
  w.setMetadata({ name: 'Two Objects' });
  await writeFile('examples/two-objects.initial.episode.zip', await encodeEpisode(w.episode));
  await w.execute('translate_objects', { ids: ['a'], delta: [0.25, 0, 0] }, 'webmcp');
  await writeFile('examples/two-objects.episode.zip', await encodeEpisode(w.episode));
} finally {
  w.dispose();
}
