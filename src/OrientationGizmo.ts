import { Camera, Quaternion, Vector3 } from 'three';

// Project world axes into camera space without adding a second WebGL context.
export function createOrientationGizmo(host: HTMLElement, onSelect: (direction: Vector3) => void) {
  const root = document.createElement('div');
  root.className = 'orientation-gizmo';
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'View orientation');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 112 112');
  svg.setAttribute('aria-hidden', 'true');
  root.append(svg);
  const axes = [
    ['X', new Vector3(1, 0, 0), 'red'],
    ['Y', new Vector3(0, 1, 0), 'green'],
    ['Z', new Vector3(0, 0, 1), 'blue'],
  ] as const;
  const points = axes.flatMap(([name, axis, color]) =>
    [1, -1].map((sign) => {
      const direction = axis.clone().multiplyScalar(sign);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', '56');
      line.setAttribute('y1', '56');
      line.style.stroke = `var(--ctp-${color})`;
      svg.append(line);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'orientation-axis' + (sign < 0 ? ' negative' : '');
      button.style.setProperty('--axis-color', `var(--ctp-${color})`);
      button.textContent = sign > 0 ? name : '−';
      button.setAttribute('aria-label', `View from ${sign > 0 ? '+' : '−'}${name}`);
      button.dataset.tooltip = `View from ${sign > 0 ? '+' : '−'}${name}`;
      button.onclick = () => onSelect(direction.clone());
      root.append(button);
      return { direction, line, button, projected: new Vector3() };
    }),
  );
  host.append(root);
  const inverse = new Quaternion();
  return {
    update(camera: Camera, disabled: boolean) {
      inverse.copy(camera.quaternion).invert();
      for (const p of points) p.projected.copy(p.direction).applyQuaternion(inverse);
      points
        .sort((a, b) => a.projected.z - b.projected.z)
        .forEach((p, i) => {
          let x = 56 + p.projected.x * 37;
          let y = 56 - p.projected.y * 37;
          // Separate the far endpoint near a pole so both directions remain clickable.
          if (p.projected.z < 0 && Math.hypot(p.projected.x, p.projected.y) < 0.35) {
            x += 20;
            y += 20;
          }
          p.line.setAttribute('x2', String(x));
          p.line.setAttribute('y2', String(y));
          p.line.style.opacity = p.projected.z < 0 ? '.3' : '.8';
          svg.append(p.line);
          p.button.style.left = x + 'px';
          p.button.style.top = y + 'px';
          p.button.style.zIndex = String(i + 1);
          p.button.style.opacity = p.projected.z < 0 ? '.55' : '1';
          p.button.disabled = disabled;
        });
    },
    dispose() {
      root.remove();
    },
  };
}
