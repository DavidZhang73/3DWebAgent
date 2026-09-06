import { useEffect, useRef, useState } from 'react';

export function useFileDrop(onDrop: (files: File[]) => void, disabled: boolean) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const intercept = (event: DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const reset = () => {
      depth.current = 0;
      setDragging(false);
    };
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      intercept(event);
      depth.current++;
      setDragging(true);
    };
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      intercept(event);
      if (event.dataTransfer) event.dataTransfer.dropEffect = disabled ? 'none' : 'copy';
    };
    const leave = (event: DragEvent) => {
      if (!depth.current) return;
      intercept(event);
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      intercept(event);
      reset();
      onDrop(Array.from(event.dataTransfer?.files ?? []));
    };
    // Capture file drops before Dockview; its internal panel drags pass through untouched.
    window.addEventListener('dragenter', enter, true);
    window.addEventListener('dragover', over, true);
    window.addEventListener('dragleave', leave, true);
    window.addEventListener('drop', drop, true);
    window.addEventListener('dragend', reset);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('dragenter', enter, true);
      window.removeEventListener('dragover', over, true);
      window.removeEventListener('dragleave', leave, true);
      window.removeEventListener('drop', drop, true);
      window.removeEventListener('dragend', reset);
      window.removeEventListener('blur', reset);
    };
  }, [onDrop, disabled]);
  return dragging;
}
