import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const files = [
  'src/runtime.ts',
  'src/pose.ts',
  'src/capabilities.ts',
  'src/types.ts',
  'src/archive.ts',
  'schema/tools.json',
  'schema/commands.json',
  'schema/results.schema.json',
  'schema/episode.schema.json',
];
const hash = createHash('sha256');
for (const file of files) {
  hash.update(file);
  hash.update(await readFile(file));
}
const require = createRequire(import.meta.url),
  wasm = await readFile(require.resolve('@mujoco/mujoco/mujoco.wasm'));
await writeFile(
  'schema/wasm-build.json',
  JSON.stringify(
    { build: hash.digest('hex'), engineBuild: createHash('sha256').update(wasm).digest('hex') },
    null,
    2,
  ) + '\n',
);
