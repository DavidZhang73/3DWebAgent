import { Matrix4, Quaternion, Vector3 } from 'three';
import type { CameraState, ObjectPose, Quat, Vec3 } from './types.ts';

export function transformPoses(poses: ObjectPose[], matrix: Matrix4): ObjectPose[] {
  const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().extractRotation(matrix));
  return poses.map((p) => {
    const q = new Quaternion(p.quaternion[1], p.quaternion[2], p.quaternion[3], p.quaternion[0])
      .premultiply(rotation)
      .normalize();
    return {
      id: p.id,
      position: new Vector3().fromArray(p.position).applyMatrix4(matrix).toArray() as Vec3,
      quaternion: [q.w, q.x, q.y, q.z] as Quat,
    };
  });
}
export function transformCamera(camera: CameraState, matrix: Matrix4): CameraState {
  return {
    position: new Vector3().fromArray(camera.position).applyMatrix4(matrix).toArray() as Vec3,
    target: new Vector3().fromArray(camera.target).applyMatrix4(matrix).toArray() as Vec3,
  };
}
export function aroundPivot(rotation: Quaternion, pivot: Vector3) {
  return new Matrix4()
    .makeTranslation(pivot.x, pivot.y, pivot.z)
    .multiply(new Matrix4().makeRotationFromQuaternion(rotation))
    .multiply(new Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
}
