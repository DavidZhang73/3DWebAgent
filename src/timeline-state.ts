import type { Frame } from './types.ts';

export function snapshotTracks(frames: Frame[]) {
  const different = (a: unknown, b: unknown) => JSON.stringify(a) !== JSON.stringify(b);
  return [
    {
      id: 'states',
      label: 'Scene snapshots',
      color: 'var(--ctp-yellow)',
      indices: frames.map((f) => f.index),
    },
    {
      id: 'objects',
      label: 'Object state',
      color: 'var(--ctp-blue)',
      indices: frames
        .filter((f, i) => !i || different(f.integration, frames[i - 1].integration))
        .map((f) => f.index),
    },
    {
      id: 'camera',
      label: 'Camera',
      color: 'var(--ctp-teal)',
      indices: frames
        .filter((f, i) => !i || different(f.camera, frames[i - 1].camera))
        .map((f) => f.index),
    },
    {
      id: 'groups',
      label: 'Groups',
      color: 'var(--ctp-mauve)',
      indices: frames
        .filter((f, i) => !i || different(f.groups, frames[i - 1].groups))
        .map((f) => f.index),
    },
  ];
}

export function operationAtPixel(pixel: number, spacing: number, last: number) {
  return Math.max(0, Math.min(last, Math.round((pixel - 24) / spacing)));
}
