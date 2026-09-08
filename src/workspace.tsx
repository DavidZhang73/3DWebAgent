import { createContext, useContext } from 'react';
import type { World } from './runtime';

export type Command =
  | 'undo'
  | 'redo'
  | 'delete'
  | 'rename'
  | 'group'
  | 'ungroup'
  | 'selectAll'
  | 'deselect'
  | 'move'
  | 'rotate'
  | 'camera'
  | 'frame'
  | 'frameAll'
  | 'play';
export type PropertyCategory = 'object' | 'physics' | 'world' | 'display' | 'webmcp';
export type Workspace = {
  propertyCategory: PropertyCategory;
  setPropertyCategory: (category: PropertyCategory) => void;
  world: World;
  replace: (world: World) => void;
  run: (action: () => unknown | Promise<unknown>) => void;
  command: (command: Command) => void;
  version: number;
};
export const WorkspaceContext = createContext<Workspace>(null!);
export const useWorkspace = () => useContext(WorkspaceContext);

export function editingText(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      'input,textarea,select,[contenteditable="true"],[contenteditable=""],[role="textbox"]',
    )
  );
}

export function shortcut(event: KeyboardEvent): Command | undefined {
  if (event.isComposing || event.repeat || editingText(event.target)) return;
  const key = event.key.toLowerCase(),
    mod = event.metaKey || event.ctrlKey;
  if (mod) {
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (key === 'g') return event.altKey ? 'ungroup' : 'group';
    return;
  }
  if (key === 'a') return event.altKey ? 'deselect' : 'selectAll';
  if (event.altKey) return;
  if (key === 'g') return 'move';
  if (key === 'r') return 'rotate';
  if (key === 'f2') return 'rename';
  if (key === 'delete') return 'delete';
  if (key === 'c' || event.code === 'Numpad0') return 'camera';
  if (key === 'f' || event.code === 'NumpadDecimal') return 'frame';
  if (key === 'home') return 'frameAll';
  if (key === ' ') return 'play';
}
