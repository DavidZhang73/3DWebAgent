import type { CSSProperties } from 'react';

const paths = {
  close: 'M6 6l12 12M18 6 6 18',
  orbit: 'M21 12a9 4 0 1 1-18 0 9 4 0 0 1 18 0M12 3a4 9 0 1 1 0 18 4 9 0 0 1 0-18',
  solid: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 3v18M4 8h16M4 16h16',
  layers: 'm12 3 10 5-10 5L2 8zM2 12l10 5 10-5M2 16l10 5 10-5',
  physics: 'M7 3h10v5H7zM12 8v6M8 11l4 4 4-4M3 20h18',
  world: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3c-5 4-5 14 0 18 5-4 5-14 0-18',
  record: 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0M9 9h6v6H9z',
  check: 'm4 12 5 5L20 6',
  copy: 'M8 8h13v13H8zM16 8V3H3v13h5',

  cursor: 'm5 3 14 9-7 1-3 7z',
  move: 'M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3',
  rotate: 'M20 10a8 8 0 1 0-2 8M20 4v6h-6',
  cube: 'm12 3 9 5v9l-9 5-9-5V8zM3 8l9 5 9-5M12 13v9M8 5l9 5',
  group: 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M7 7h10v10H7z',
  frame: 'M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5M9 9h6v6H9z',
  camera: 'M3 7h5l2-3h4l2 3h5v13H3zM16 13a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  grid: 'M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18',
  settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  terminal: 'm4 6 6 6-6 6M13 18h7',
  play: 'm8 4 12 8-12 8z',
  pause: 'M8 4v16M16 4v16',
  first: 'M5 4v16M19 5l-10 7 10 7z',
  last: 'M19 4v16M5 5l10 7-10 7z',
  previous: 'm15 5-9 7 9 7',
  next: 'm9 5 9 7-9 7',
  loop: 'M3 7h14l4 4M21 4v7h-7M21 17H7l-4-4M3 20v-7h7',
  minus: 'M5 12h14',
  plus: 'M5 12h14M12 5v14',
  chevron: 'm8 10 4 4 4-4',
  file: 'M6 3h8l4 4v14H6zM14 3v5h4',
  save: 'M4 3h14l3 3v15H3V3zM7 3v6h10V3M7 21v-8h10v8',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  lock: 'M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4M12 14v3',
  undo: 'M8 4 3 9l5 5M3 9h10a7 7 0 0 1 0 14',
  redo: 'm16 4 5 5-5 5M21 9H11a7 7 0 0 0 0 14',
  trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  search: 'M15 15l6 6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  history: 'M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v6l4 2',
} as const;
export type IconName = keyof typeof paths;
export function Icon({
  name,
  size = 16,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
