import { Quaternion, Vector3, Spherical } from 'three';
import type { CameraState, Vec3 } from './types.ts';
export function cameraAxes(camera: CameraState) {
  const forward = new Vector3()
    .fromArray(camera.target)
    .sub(new Vector3().fromArray(camera.position))
    .normalize();
  let right = forward.clone().cross(new Vector3(0, 0, 1));
  if (right.lengthSq() < 1e-10) right = forward.clone().cross(new Vector3(0, 1, 0));
  right.normalize();
  return [right, right.clone().cross(forward).normalize(), forward];
}
export function rotationFor(angles: number[], axes: Vector3[]) {
  const q = new Quaternion();
  angles.forEach((a, i) =>
    q.premultiply(new Quaternion().setFromAxisAngle(axes[i], (a * Math.PI) / 180)),
  );
  return q.normalize();
}
export function movedCamera(camera: CameraState, input: Record<string, unknown>): CameraState {
  const { yaw = 0, pitch = 0, zoom = 1, right = 0, up = 0 } = input as Record<string, number>;
  const offset = new Vector3()
    .fromArray(camera.position)
    .sub(new Vector3().fromArray(camera.target));
  offset.applyAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2);
  const s = new Spherical().setFromVector3(offset);
  s.theta += (yaw * Math.PI) / 180;
  s.phi = Math.max(0.02, Math.min(Math.PI - 0.02, s.phi + (pitch * Math.PI) / 180));
  s.radius = Math.max(0.01, s.radius * zoom);
  offset.setFromSpherical(s).applyAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
  const axes = cameraAxes(camera),
    target = new Vector3()
      .fromArray(camera.target)
      .addScaledVector(axes[0], right)
      .addScaledVector(axes[1], up);
  return {
    position: target.clone().add(offset).toArray() as Vec3,
    target: target.toArray() as Vec3,
  };
}
