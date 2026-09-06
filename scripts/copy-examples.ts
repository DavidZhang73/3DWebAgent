import { cp, mkdir } from 'node:fs/promises';

// Publish only the curated demos, never generated tests or local episodes.
await mkdir('dist/examples', { recursive: true });
for (const name of ['applaro', 'reidar', 'vittsjo', 'source.json'])
  await cp(`examples/${name}`, `dist/examples/${name}`, { recursive: true });
