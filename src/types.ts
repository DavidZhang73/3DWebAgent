import build from '../schema/wasm-build.json' with { type: 'json' };
export type Assets = Record<string, Uint8Array>;
export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];
export type CameraState = { position: Vec3; target: Vec3 };
export type Group = { id: string; name: string; members: string[] };
export type Frame = {
  index: number;
  integration: number[];
  camera: CameraState;
  groups: Group[];
  groupCounter: number;
};
export type Physics = {
  enabled: boolean;
  gravity: Vec3;
  detection: boolean;
  response: boolean;
  strategy: 'fixed' | 'settle';
  duration: number;
  maxDuration: number;
  quietDuration: number;
  linearThreshold: number;
  angularThreshold: number;
};
export const TOOL_NAMES = [
  'list_objects',
  'get_object',
  'get_scene',
  'get_state',
  'translate_objects',
  'rotate_objects',
  'set_object_pose',
  'group_objects',
  'ungroup_objects',
  'capture_scene',
  'move_camera',
  'apply_force',
  'start_episode',
  'advance_simulation',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export type ObjectInfo = { id: string; name: string; type: 'rigid'; collisionEnabled?: boolean };
export type ObjectPose = { id: string; position: Vec3; quaternion: Quat };
export type RuntimeConfig = { physics: Physics; enabledTools: ToolName[] };
export type Manifest = {
  format: '3dwebagent-episode';
  version: 1;
  id: string;
  contract: '3dwebagent-runtime-1';
  lifecycle: 'setup' | 'active' | 'ended';
  originTime: number;
  task?: string;
  end?: { reason: string; outcome?: string };
  requiredCapabilities: string[];
  producer: Producer;
  engine: '3.12.0';
  name: string;
  units: 'SI' | 'normalized';
  stateSpec: number;
  stateSize: number;
  runtime: RuntimeConfig;
  objects: ObjectInfo[];
  hashes: Record<string, string>;
};
export type Producer = {
  language: string;
  backend: 'wasm' | 'native';
  engine: string;
  implementation: string;
  renderer?: string;
  build?: string;
  engineBuild?: string;
};
export type CommandName = ToolName | 'edit_poses' | 'set_camera';
export type TraceFrame = Frame & {
  call_id: string;
  phase: 'input' | 'physics' | 'final' | 'rollback';
  step: number;
  sim_time: number;
  applied?: { body: number; values: number[] };
};
export type RunEvent = {
  index: number;
  call_id: string;
  kind: 'request' | 'complete';
  timestamp: string;
  sim_time: number;
};
export type McpCall = {
  index: number;
  name: CommandName;
  id: string;
  actor: 'agent' | 'human';
  producer: Producer;
  before_index: number;
  trace_start: number;
  trace_end: number;
  sim_start: number;
  sim_end: number;
  steps: number;
  result?: unknown;
  error_code?: string;
  cancellation?: { phase: string; step: number };
  transport?: string;
  arguments: Input;
  timestamp: string;
  state_index: number;
  status: 'completed' | 'error';
  error?: string;
};
export type Episode = {
  manifest: Manifest;
  assets: Assets;
  initial: Frame;
  states: Frame[];
  calls?: McpCall[];
  events: RunEvent[];
  trajectory: TraceFrame[];
  observations: Assets;
  revision: number;
};
export type Source = 'manual' | 'webmcp';
export type Input = Record<string, unknown>;
export const defaultRuntime = (): RuntimeConfig => ({
  enabledTools: TOOL_NAMES.filter((t) => t !== 'apply_force'),
  physics: {
    enabled: false,
    gravity: [0, 0, -9.81],
    detection: true,
    response: true,
    strategy: 'fixed',
    duration: 0.25,
    maxDuration: 5,
    quietDuration: 0.1,
    linearThreshold: 0.01,
    angularThreshold: 0.01,
  },
});
export const defaultCamera = (): CameraState => ({ position: [2.5, -3.6, 2.8], target: [0, 0, 0] });

export const PRODUCER: Producer = {
  ...build,
  language: 'typescript',
  backend: 'wasm',
  engine: '3.12.0',
  implementation: '3dwebagent-runtime-1',
};
export const LIFECYCLE_TOOLS: ToolName[] = ['start_episode'];
