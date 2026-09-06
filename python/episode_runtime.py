"""Headless native implementation of the public 3DWebAgent runtime contract."""

from __future__ import annotations
import copy
import hashlib
import json
import math
import re
import uuid
import zipfile
from tempfile import TemporaryDirectory
from datetime import datetime, timezone
from pathlib import Path

import jsonschema
import mujoco
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
TOOLS = json.loads((ROOT / "schema/tools.json").read_text())
COMMANDS = json.loads((ROOT / "schema/commands.json").read_text())
RESULTS = json.loads((ROOT / "schema/results.schema.json").read_text())
SCHEMA = json.loads((ROOT / "schema/episode.schema.json").read_text())
PRODUCER = dict(
    language="python",
    backend="native",
    engine="3.12.0",
    implementation="3dwebagent-runtime-1",
)
PRODUCER["build"] = hashlib.sha256(
    Path(__file__).read_bytes()
    + b"".join(
        (ROOT / p).read_bytes()
        for p in (
            "schema/tools.json",
            "schema/commands.json",
            "schema/results.schema.json",
            "schema/episode.schema.json",
        )
    )
).hexdigest()
_native_libraries = sorted(Path(mujoco.__file__).parent.glob("libmujoco*"))
if _native_libraries:
    PRODUCER["engineBuild"] = hashlib.sha256(
        _native_libraries[0].read_bytes()
    ).hexdigest()
LIFECYCLE = ("start_episode",)


def clone(value):
    return copy.deepcopy(value)


def now():
    return (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )


def safe_path(path):
    if (
        not path
        or path.startswith("/")
        or "\\" in path
        or ":" in path
        or any(p in ("", ".", "..") for p in path.split("/"))
    ):
        raise ValueError("Unsafe archive path")
    return path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def dumps(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False)


def validate(ep):
    jsonschema.validate(
        {k: v for k, v in ep.items() if k not in ("assets", "observations")}, SCHEMA
    )
    m = ep["manifest"]
    if (
        m["runtime"]["physics"]["quietDuration"]
        > m["runtime"]["physics"]["maxDuration"]
    ):
        raise ValueError("Invalid quiet duration")
    objects = {o["id"] for o in m["objects"]}
    if len(objects) != len(m["objects"]) or "model.xml" not in ep["assets"]:
        raise ValueError("Invalid object catalog or missing model")
    for path in ep["assets"]:
        safe_path(path)
    for key, data in ep["observations"].items():
        if (
            key != digest(data) + ".png"
            or len(data) < 24
            or data[:8] != b"\x89PNG\r\n\x1a\n"
        ):
            raise ValueError("Invalid PNG observation")

    def check_observation(value):
        if isinstance(value, dict):
            if (
                value.get("type") == "image"
                and value.get("observation") not in ep["observations"]
            ):
                raise ValueError("Missing observation reference")
            for v in value.values():
                check_observation(v)
        elif isinstance(value, list):
            for v in value:
                check_observation(v)

    calls = ep.get("calls", [])
    for c in calls:
        check_observation(c.get("result"))
        if c["status"] == "completed":
            jsonschema.validate(dict(name=c["name"], result=c.get("result")), RESULTS)
    ids = {c["id"] for c in calls}
    if len(ids) != len(calls):
        raise ValueError("Duplicate call ID")
    for collection in ([ep["initial"], *ep["states"]], ep["trajectory"]):
        for i, f in enumerate(collection):
            if (
                f["index"] != i
                or len(f["integration"]) != m["stateSize"]
                or not np.isfinite(f["integration"]).all()
            ):
                raise ValueError("Invalid state layout")
            camera = f["camera"]
            if (
                not np.isfinite([camera["position"], camera["target"]]).all()
                or np.linalg.norm(np.subtract(camera["position"], camera["target"]))
                < 0.001
            ):
                raise ValueError("Invalid camera")
            members, groups = set(), set()
            for g in f["groups"]:
                if g["id"] in groups | objects or len(g["members"]) < 2:
                    raise ValueError("Invalid group")
                groups.add(g["id"])
                for member in g["members"]:
                    if member not in objects or member in members:
                        raise ValueError("Invalid group membership")
                    members.add(member)
    for i, event in enumerate(ep["events"]):
        if event["index"] != i or event["call_id"] not in ids:
            raise ValueError("Invalid event")
        datetime.fromisoformat(event["timestamp"].replace("Z", "+00:00"))
    for i, c in enumerate(calls):
        datetime.fromisoformat(c["timestamp"].replace("Z", "+00:00"))
        if (
            c["index"] != i
            or c["before_index"] > len(ep["states"])
            or c["state_index"] > len(ep["states"])
            or not 0 <= c["trace_start"] <= c["trace_end"] <= len(ep["trajectory"])
        ):
            raise ValueError("Invalid call reference")
        if (c["status"] == "error") != ("error" in c):
            raise ValueError("Invalid call error")
        events = [e["kind"] for e in ep["events"] if e["call_id"] == c["id"]]
        if events != ["request", "complete"] or any(
            f["call_id"] != c["id"]
            for f in ep["trajectory"][c["trace_start"] : c["trace_end"]]
        ):
            raise ValueError("Invalid call events or trajectory")
    owners = {c["id"]: c for c in calls}
    if any(
        f["call_id"] not in owners
        or not owners[f["call_id"]]["trace_start"]
        <= i
        < owners[f["call_id"]]["trace_end"]
        for i, f in enumerate(ep["trajectory"])
    ):
        raise ValueError("Invalid trajectory reference")
    if m["lifecycle"] == "setup" and (
        calls or ep["states"] or ep["trajectory"] or ep["events"]
    ):
        raise ValueError("Setup contains run history")
    if (m["lifecycle"] == "ended") != ("end" in m):
        raise ValueError("Invalid lifecycle end")


def load(path):
    with zipfile.ZipFile(path) as z:
        if len(z.namelist()) != len(set(z.namelist())):
            raise ValueError("Duplicate archive member")
        files = {safe_path(n): z.read(n) for n in z.namelist()}
    m = json.loads(files.pop("manifest.json"))
    if {k: digest(v) for k, v in files.items()} != m["hashes"]:
        raise ValueError("Archive checksum mismatch")

    def lines(name):
        return [json.loads(x) for x in files[name].splitlines() if x.strip()]

    ep = dict(
        manifest=m,
        assets={},
        observations={},
        states=[],
        trajectory=[],
        calls=lines("calls.jsonl"),
        events=lines("events.jsonl"),
        revision=0,
    )
    for p, b in files.items():
        if p.startswith("world/"):
            ep["assets"][p[6:]] = b
        elif p.startswith("observations/"):
            if p[13:] != digest(b) + ".png":
                raise ValueError("Invalid observation hash")
            ep["observations"][p[13:]] = b
        elif p not in ("frames.bin", "frames.jsonl", "calls.jsonl", "events.jsonl"):
            raise ValueError("Unexpected archive member")
    rows = lines("frames.jsonl")
    if len(files["frames.bin"]) != len(rows) * m["stateSize"] * 8:
        raise ValueError("Invalid state layout")
    data = np.frombuffer(files["frames.bin"], dtype="<f8").reshape(
        len(rows), m["stateSize"]
    )
    for i, row in enumerate(rows):
        kind = row.pop("kind")
        f = dict(row, integration=data[i].tolist())
        if i == 0 and kind == "initial":
            ep["initial"] = f
        elif kind == "state":
            ep["states"].append(f)
        elif kind == "trace":
            ep["trajectory"].append(f)
        else:
            raise ValueError("Invalid frame kind")
    validate(ep)
    return ep


def save(ep, path):
    validate(ep)
    files = {"world/" + safe_path(k): v for k, v in ep["assets"].items()}
    files.update(
        {"observations/" + safe_path(k): v for k, v in ep["observations"].items()}
    )
    rows = [
        ("initial", ep["initial"]),
        *[("state", f) for f in ep["states"]],
        *[("trace", f) for f in ep["trajectory"]],
    ]
    files["frames.bin"] = np.asarray(
        [f["integration"] for _, f in rows], dtype="<f8"
    ).tobytes()
    files["frames.jsonl"] = "\n".join(
        dumps(dict(kind=k, **{a: b for a, b in f.items() if a != "integration"}))
        for k, f in rows
    ).encode()
    for key in ("calls", "events"):
        files[key + ".jsonl"] = "\n".join(dumps(c) for c in ep.get(key, [])).encode()
    m = dict(ep["manifest"], hashes={k: digest(b) for k, b in files.items()})
    files["manifest.json"] = dumps(m).encode()
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in files.items():
            z.writestr(name, data)


def as_initial(ep, frame=None, preserve_id=False):
    m = clone(ep["manifest"])
    m.update(
        id=m["id"] if preserve_id else str(uuid.uuid4()), lifecycle="setup", hashes={}
    )
    m.pop("end", None)
    frame = clone(frame or ep["initial"])
    frame["index"] = 0
    m["originTime"] = frame["integration"][0]
    return dict(
        manifest=m,
        assets=ep["assets"],
        initial=frame,
        states=[],
        calls=[],
        events=[],
        trajectory=[],
        observations={},
        revision=0,
    )


def norm(v):
    v = np.asarray(v, dtype=float)
    n = math.sqrt(sum(float(x) ** 2 for x in v))
    return v / n if n else v


def qmul(a, b):
    w, x, y, z = a
    v, i, j, k = b
    return np.array(
        [
            w * v - x * i - y * j - z * k,
            w * i + x * v + y * k - z * j,
            w * j - x * k + y * v + z * i,
            w * k + x * j - y * i + z * v,
        ]
    )


def qapply(v, q):
    # Matches Three.js Vector3.applyQuaternion for unit quaternions.
    v = np.asarray(v, dtype=float)
    t = 2 * np.cross(q[1:], v)
    return v + q[0] * t + np.cross(q[1:], t)


def axis_quat(axis, angle):
    return np.array([math.cos(angle / 2), *(np.asarray(axis) * math.sin(angle / 2))])


def camera_axes(camera):
    forward = norm(np.subtract(camera["target"], camera["position"]))
    right = np.cross(forward, [0, 0, 1])
    if np.dot(right, right) < 1e-10:
        right = np.cross(forward, [0, 1, 0])
    right = norm(right)
    return [right, norm(np.cross(right, forward)), forward]


def moved_camera(camera, args):
    offset = qapply(
        np.subtract(camera["position"], camera["target"]),
        axis_quat([1, 0, 0], -math.pi / 2),
    )
    radius = math.sqrt(sum(float(x) ** 2 for x in offset))
    theta = math.atan2(offset[0], offset[2]) + args.get("yaw", 0) * math.pi / 180
    phi = min(
        math.pi - 0.02,
        max(
            0.02,
            math.acos(max(-1, min(1, offset[1] / radius)))
            + args.get("pitch", 0) * math.pi / 180,
        ),
    )
    radius = max(0.01, radius * args.get("zoom", 1))
    offset = qapply(
        [
            radius * math.sin(phi) * math.sin(theta),
            radius * math.cos(phi),
            radius * math.sin(phi) * math.cos(theta),
        ],
        axis_quat([1, 0, 0], math.pi / 2),
    )
    axes = camera_axes(camera)
    target = (
        np.array(camera["target"])
        + axes[0] * args.get("right", 0)
        + axes[1] * args.get("up", 0)
    )
    return dict(position=(target + offset).tolist(), target=target.tolist())


def error_code(message):
    if "cancelled" in message.lower():
        return "cancelled"
    if "running" in message or "Wait for" in message:
        return "busy"
    if "Unsupported capability" in message:
        return "unsupported_capability"
    if "ended" in message:
        return "episode_ended"
    if "disabled" in message:
        return "disabled"
    if "unstable" in message or "Non-finite" in message:
        return "unstable_physics"
    return "invalid_argument"


class Runtime:
    capabilities = ["state", *[name for name in TOOLS if name != "capture_scene"]]

    def __init__(self, episode):
        validate(episode)
        self.episode = clone(episode)
        self.m = self.episode["manifest"]
        if (
            mujoco.__version__ != self.m["engine"]
            or self.m["contract"] != "3dwebagent-runtime-1"
            or any(c != "state" for c in self.m["requiredCapabilities"])
        ):
            raise ValueError("Incompatible runtime contract or capability")
        for name, data in self.episode["assets"].items():
            if name.endswith(".xml"):
                for match in re.finditer(
                    r"\b(file|meshdir|texturedir|assetdir)\s*=\s*[\"']([^\"']*)[\"']",
                    data.decode(),
                ):
                    reference = (
                        match.group(2)
                        if match.group(1) == "file"
                        else match.group(2).removesuffix("/")
                    )
                    if "&" in reference:
                        raise ValueError("Encoded resource paths are unsupported")
                    if reference:
                        safe_path(reference)
        # Compile from an isolated asset root: never fall back to the caller's cwd.
        with TemporaryDirectory(prefix="3dwebagent-model-") as directory:
            for name, data in self.episode["assets"].items():
                target = Path(directory) / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            self.model = mujoco.MjModel.from_xml_path(
                str(Path(directory) / "model.xml")
            )

        model = self.model
        if (
            model.nplugin
            or model.nflex
            or model.nskin
            or model.ntex
            or any(t not in (0, 2, 3, 4, 5, 6, 7) for t in model.geom_type)
        ):
            raise ValueError("Unsupported model capability")
        if not 0 < model.opt.timestep <= 0.1:
            raise ValueError("Invalid timestep")
        self.spec = mujoco.mjtState.mjSTATE_INTEGRATION
        self.size = mujoco.mj_stateSize(model, self.spec)
        if (
            self.size != self.m["stateSize"]
            or int(self.spec) != self.m["stateSpec"]
            or len(self.m["objects"]) != model.nbody - 1
        ):
            raise ValueError("Incompatible state layout")
        self.original_collision = [
            model.geom_contype.copy(),
            model.geom_conaffinity.copy(),
        ]
        self.data = mujoco.MjData(model)
        self.camera = clone(self.episode["initial"]["camera"])
        self.groups = []
        self.group_counter = 0
        self.active_call = None
        self.step = 0
        self.cancel_at_step = None
        self.apply_physics()
        self.restore(
            self.episode["states"][-1]
            if self.episode["states"]
            else self.episode["initial"]
        )

    def body(self, name):
        body = mujoco.mj_name2id(self.model, mujoco.mjtObj.mjOBJ_BODY, name)
        if body < 1:
            raise ValueError("Unknown object: " + name)
        return body

    def name(self, body):
        return mujoco.mj_id2name(
            self.model, mujoco.mjtObj.mjOBJ_BODY, int(body)
        ) or "body-" + str(body)

    def address(self, name):
        b = self.body(name)
        j = self.model.body_jntadr[b]
        if (
            self.model.body_parentid[b] != 0
            or self.model.body_jntnum[b] != 1
            or self.model.jnt_type[j] != 0
        ):
            raise ValueError("Object requires an independent free joint: " + name)
        return b, self.model.jnt_qposadr[j], self.model.jnt_dofadr[j]

    def apply_physics(self):
        p = self.m["runtime"]["physics"]
        m = self.model
        m.opt.gravity[:] = p["gravity"] if p["enabled"] else [0, 0, 0]
        disabled = {
            self.body(o["id"])
            for o in self.m["objects"]
            if o.get("collisionEnabled") is False
        }
        for i in range(m.npair):
            if (
                m.geom_bodyid[m.pair_geom1[i]] in disabled
                or m.geom_bodyid[m.pair_geom2[i]] in disabled
            ):
                raise ValueError(
                    "Collision overrides do not support explicit contact pairs."
                )
        for target, values in zip(
            (m.geom_contype, m.geom_conaffinity), self.original_collision
        ):
            target[:] = [
                v if p["detection"] and m.geom_bodyid[g] not in disabled else 0
                for g, v in enumerate(values)
            ]
        contact = int(mujoco.mjtDisableBit.mjDSBL_CONTACT)
        constraint = int(mujoco.mjtDisableBit.mjDSBL_CONSTRAINT)
        m.opt.disableflags = (
            (m.opt.disableflags | int(mujoco.mjtDisableBit.mjDSBL_AUTORESET))
            & ~contact
            & ~constraint
        )
        if not p["detection"]:
            m.opt.disableflags |= contact
        if not p["response"]:
            m.opt.disableflags |= constraint

    def snapshot(self, index=None):
        state = np.empty(self.size)
        mujoco.mj_getState(self.model, self.data, state, self.spec)
        return dict(
            index=len(self.episode["states"]) if index is None else index,
            integration=state.tolist(),
            camera=clone(self.camera),
            groups=clone(self.groups),
            groupCounter=self.group_counter,
        )

    def restore(self, frame):
        mujoco.mj_setState(
            self.model, self.data, np.array(frame["integration"]), self.spec
        )
        mujoco.mj_forward(self.model, self.data)
        mujoco.mj_setState(
            self.model, self.data, np.array(frame["integration"]), self.spec
        )
        self.camera = clone(frame["camera"])
        self.groups = clone(frame["groups"])
        self.group_counter = frame["groupCounter"]

    def object(self, name):
        b = self.body(name)
        m = self.model
        d = self.data
        info = next(o for o in self.m["objects"] if o["id"] == name)
        return dict(
            info,
            position=d.xpos[b].tolist(),
            quaternion=d.xquat[b].tolist(),
            velocity=d.cvel[b].tolist(),
            mass=float(m.body_mass[b]),
            movable=bool(
                m.body_parentid[b] == 0
                and m.body_jntnum[b] == 1
                and m.jnt_type[m.body_jntadr[b]] == 0
            ),
            inertia=m.body_inertia[b].tolist(),
            centerOfMass=m.body_ipos[b].tolist(),
            inertiaQuaternion=m.body_iquat[b].tolist(),
            geometries=[
                dict(
                    index=g,
                    type=int(m.geom_type[g]),
                    size=m.geom_size[g].tolist(),
                    friction=m.geom_friction[g].tolist(),
                    condim=int(m.geom_condim[g]),
                    collidable=bool(
                        self.original_collision[0][g] or self.original_collision[1][g]
                    ),
                )
                for g in range(m.ngeom)
                if m.geom_bodyid[g] == b
            ],
        )

    def contacts(self):
        if not self.m["runtime"]["physics"]["detection"]:
            return []
        m = self.model
        flags = m.opt.disableflags
        try:
            m.opt.disableflags &= ~int(mujoco.mjtDisableBit.mjDSBL_CONTACT) & ~int(
                mujoco.mjtDisableBit.mjDSBL_CONSTRAINT
            )
            mujoco.mj_collision(m, self.data)
        finally:
            m.opt.disableflags = flags
        contacts = [
            dict(
                objects=[
                    self.name(m.geom_bodyid[c.geom1]),
                    self.name(m.geom_bodyid[c.geom2]),
                ],
                position=c.pos.tolist(),
                distance=float(c.dist),
            )
            for c in self.data.contact
        ]
        return sorted(
            contacts, key=lambda c: (*c["objects"], *c["position"], c["distance"])
        )

    def state(self):
        return dict(
            index=len(self.episode["states"]),
            units=self.m["units"],
            objects=[self.object(o["id"]) for o in self.m["objects"]],
            groups=clone(self.groups),
            camera=clone(self.camera),
            contacts=self.contacts(),
        )

    def trace(self, phase, force=None):
        if self.active_call is None:
            return
        f = self.snapshot()
        if not np.isfinite(f["integration"]).all():
            return
        f.update(
            index=len(self.episode["trajectory"]),
            call_id=self.active_call["id"],
            phase=phase,
            step=self.step,
            sim_time=float(self.data.time - self.m["originTime"]),
        )
        if force is not None:
            f["applied"] = clone(force)
        self.episode["trajectory"].append(f)

    def simulate(self, force=None, duration=None):
        p = self.m["runtime"]["physics"]
        dt = self.model.opt.timestep
        if not p["enabled"]:
            return dict(physics="disabled")
        fixed = math.ceil((p["duration"] if duration is None else duration) / dt)
        maximum = (
            fixed
            if duration is not None or p["strategy"] == "fixed"
            else math.ceil(p["maxDuration"] / dt) + (fixed if force else 0)
        )
        quiet = 0
        for i in range(maximum):
            if self.cancel_at_step == self.step:
                raise ValueError("Operation cancelled.")
            self.data.xfrc_applied[:] = 0
            if force and i < fixed:
                self.data.xfrc_applied[force["body"], :3] = force["values"]
            mujoco.mj_step(self.model, self.data)
            self.step += 1
            self.trace("physics", force if force and i < fixed else None)
            if (
                not np.isfinite(self.data.qpos).all()
                or not np.isfinite(self.data.qvel).all()
                or np.any(np.abs(self.data.qvel) > 1e8)
            ):
                raise ValueError("Non-finite or unstable physics state.")
            resting = True
            for o in self.m["objects"]:
                b = self.body(o["id"])
                j = self.model.body_jntadr[b]
                if self.model.body_jntnum[b] == 1 and self.model.jnt_type[j] == 0:
                    v = self.model.jnt_dofadr[j]
                    if (
                        np.linalg.norm(self.data.qvel[v : v + 3]) > p["linearThreshold"]
                        or np.linalg.norm(self.data.qvel[v + 3 : v + 6])
                        > p["angularThreshold"]
                    ):
                        resting = False
            quiet = quiet + dt if resting and (not force or i >= fixed) else 0
            if (
                duration is None
                and p["strategy"] == "settle"
                and quiet >= p["quietDuration"]
            ):
                self.data.xfrc_applied[:] = 0
                return dict(physics="settled", steps=self.step)
        self.data.xfrc_applied[:] = 0
        return dict(
            physics="advanced"
            if duration is not None or p["strategy"] == "fixed"
            else "timeout",
            steps=self.step,
        )

    def commit(self, operation, physical=False, force=None, duration=None):
        before = self.snapshot()
        try:
            if self.cancel_at_step == self.step:
                raise ValueError("Operation cancelled.")
            result = operation()
            self.trace("input")
            mujoco.mj_forward(self.model, self.data)
            physics = self.simulate(force, duration) if physical else {}
            self.restore(self.snapshot())
            recording = self.m["lifecycle"] != "setup"
            after = self.snapshot(len(self.episode["states"]) + 1 if recording else 0)
            if recording:
                self.episode["states"].append(after)
            else:
                self.episode["initial"] = after
            self.trace("final")
            return dict(
                status="completed",
                **physics,
                **({"result": result} if result is not None else {}),
                index=after["index"],
            )
        except Exception:
            self.restore(before)
            self.trace("rollback")
            raise

    def start(self):
        if self.m["lifecycle"] == "setup":
            self.episode["initial"] = self.snapshot(0)
            self.m["originTime"] = float(self.data.time)
            self.m["lifecycle"] = "active"
            self.episode["revision"] += 1

    def execute(self, name, args, actor="agent"):
        if self.m["lifecycle"] == "ended":
            raise ValueError("Episode has ended.")
        if actor == "agent" or name in LIFECYCLE:
            self.start()
        if self.m["lifecycle"] == "setup":
            self.step = 0
            return self.operation(name, args, actor)
        calls = self.episode.setdefault("calls", [])
        c = dict(
            index=len(calls),
            id="call-" + str(len(calls)),
            name=name,
            arguments=clone(args),
            actor=actor,
            producer=clone(PRODUCER),
            timestamp=now(),
            before_index=len(self.episode["states"]),
            state_index=len(self.episode["states"]),
            trace_start=len(self.episode["trajectory"]),
            trace_end=len(self.episode["trajectory"]),
            sim_start=float(self.data.time - self.m["originTime"]),
            sim_end=float(self.data.time - self.m["originTime"]),
            steps=0,
            status="completed",
        )
        calls.append(c)

        def event(kind):
            self.episode["events"].append(
                dict(
                    index=len(self.episode["events"]),
                    call_id=c["id"],
                    kind=kind,
                    timestamp=now(),
                    sim_time=float(self.data.time - self.m["originTime"]),
                )
            )

        event("request")
        self.active_call = c
        self.step = 0
        try:
            result = self.operation(name, args, actor)
            c["result"] = clone(result)
            return result
        except Exception as e:
            c.update(status="error", error=str(e), error_code=error_code(str(e)))
            if c["error_code"] == "cancelled":
                c["cancellation"] = dict(
                    phase="physics" if self.step else "input", step=self.step
                )
            raise
        finally:
            c.update(
                state_index=len(self.episode["states"]),
                trace_end=len(self.episode["trajectory"]),
                steps=self.step,
                sim_end=float(self.data.time - self.m["originTime"]),
            )
            event("complete")
            self.active_call = None
            self.episode["revision"] += 1

    def operation(self, name, args, actor):
        if name in TOOLS:
            try:
                jsonschema.validate(args, TOOLS[name]["inputSchema"])
            except jsonschema.ValidationError as e:
                raise ValueError("Invalid " + name + " arguments.") from e
        elif name in COMMANDS:
            try:
                jsonschema.validate(args, COMMANDS[name]["inputSchema"])
            except jsonschema.ValidationError as e:
                raise ValueError("Invalid " + name + " arguments.") from e
            if actor != "human":
                raise ValueError("Internal commands require a human actor.")
        else:
            raise ValueError("Invalid command")
        # Reject nonfinite values even when the JSON Schema library accepts NaN.
        dumps(args)
        if (
            actor == "agent"
            and name in TOOLS
            and name not in self.m["runtime"]["enabledTools"]
        ):
            raise ValueError("Tool is disabled: " + name)
        if self.cancel_at_step == 0:
            raise ValueError("Operation cancelled.")
        if name == "start_episode":
            if "task" in args and len(self.episode["calls"]) == 1:
                self.m["task"] = args["task"]
            return dict(status="active")
        if name == "list_objects":
            return dict(objects=clone(self.m["objects"]), groups=clone(self.groups))
        if name == "get_object":
            return self.object(args["id"])
        if name == "get_scene":
            return dict(
                name=self.m["name"],
                units=self.m["units"],
                up="Z",
                quaternion="wxyz",
                runtime=clone(self.m["runtime"]),
                objects=clone(self.m["objects"]),
            )
        if name == "get_state":
            return self.state()
        if name == "capture_scene":
            raise ValueError("Unsupported capability: capture_scene")
        if name in ("move_camera", "set_camera"):
            camera = (
                moved_camera(self.camera, args)
                if name == "move_camera"
                else clone(args["camera"])
            )
            if (
                not np.isfinite([camera["position"], camera["target"]]).all()
                or np.linalg.norm(np.subtract(camera["position"], camera["target"]))
                < 0.001
            ):
                raise ValueError("Invalid camera")
            return self.commit(lambda: setattr(self, "camera", camera))
        if name == "advance_simulation":
            if not self.m["runtime"]["physics"]["enabled"]:
                raise ValueError("Physics is disabled.")
            before = self.data.time
            result = self.commit(lambda: None, True, duration=args["duration"])
            return dict(result, duration=float(self.data.time - before))
        if name == "edit_poses":
            poses = args["poses"]
            if not poses or len({p["id"] for p in poses}) != len(poses):
                raise ValueError("Invalid poses.")
            for pose in poses:
                self.address(pose["id"])
                jsonschema.validate(pose, TOOLS["set_object_pose"]["inputSchema"])
                if np.linalg.norm(pose["quaternion"]) < 1e-8:
                    raise ValueError("Quaternion cannot be zero.")

            def edit():
                for p in poses:
                    _, q, v = self.address(p["id"])
                    self.data.qpos[q : q + 3] = p["position"]
                    self.data.qpos[q + 3 : q + 7] = norm(p["quaternion"])
                    self.data.qvel[v : v + 6] = 0

            return self.commit(edit, True)
        if name == "ungroup_objects":

            def ungroup():
                if any(not any(g["id"] == i for g in self.groups) for i in args["ids"]):
                    raise ValueError("Unknown group.")
                self.groups = [g for g in self.groups if g["id"] not in args["ids"]]

            return self.commit(ungroup)
        ids = []
        for i in args.get("ids", [args.get("id")]):
            group = next((g for g in self.groups if g["id"] == i), None)
            for member in group["members"] if group else [i]:
                if member not in ids:
                    ids.append(member)
        for i in ids:
            self.address(i)
        if name == "group_objects":

            def group():
                if len(ids) < 2:
                    raise ValueError("At least two objects are required.")
                self.groups = [
                    g for g in self.groups if not any(i in ids for i in g["members"])
                ]
                self.group_counter += 1
                g = dict(
                    id="group-" + self.m["id"] + "-" + str(self.group_counter),
                    name=args.get("name") or "Group",
                    members=ids,
                )
                self.groups.append(g)
                return clone(g)

            return self.commit(group)
        force = (
            dict(body=self.address(args["id"])[0], values=args["force"])
            if name == "apply_force"
            else None
        )
        if force and (
            not self.m["runtime"]["physics"]["enabled"]
            or np.linalg.norm(force["values"]) > 20
        ):
            raise ValueError("Force requires enabled physics and magnitude <=20 N.")

        def transform():
            if force:
                return
            axes = (
                camera_axes(self.camera) if args.get("space") == "camera" else np.eye(3)
            )
            center = (
                np.array(args["pivot"])
                if "pivot" in args
                else sum(
                    (
                        self.data.qpos[
                            self.address(i)[1] : self.address(i)[1] + 3
                        ].copy()
                        for i in ids
                    ),
                    np.zeros(3),
                )
                / len(ids)
            )
            rotation = np.array([1.0, 0, 0, 0])
            if name == "rotate_objects":
                for angle, axis in zip(args["angles"], axes):
                    rotation = qmul(axis_quat(axis, angle * math.pi / 180), rotation)
                rotation = norm(rotation)
            delta = sum(
                (axis * v for axis, v in zip(axes, args.get("delta", [0, 0, 0]))),
                np.zeros(3),
            )
            for i in ids:
                _, q, v = self.address(i)
                pos = self.data.qpos[q : q + 3].copy()
                quat = self.data.qpos[q + 3 : q + 7].copy()
                if name == "translate_objects":
                    pos += delta
                if name == "rotate_objects":
                    pos = qapply(pos - center, rotation) + center
                    quat = qmul(rotation, quat)
                if name == "set_object_pose":
                    if "position" in args:
                        pos = np.array(args["position"])
                    if "quaternion" in args:
                        if np.linalg.norm(args["quaternion"]) < 1e-8:
                            raise ValueError("Quaternion cannot be zero.")
                        quat = norm(args["quaternion"])
                self.data.qpos[q : q + 3] = pos
                self.data.qpos[q + 3 : q + 7] = quat
                self.data.qvel[v : v + 6] = 0

        return self.commit(transform, True, force)


def verify(ep, mode="continuous", atol=0.0, rtol=0.0):
    report = dict(
        status="passed",
        mode=mode,
        exact=True,
        atol=atol,
        rtol=rtol,
        checked=0,
        coverage=[
            "state",
            "commands",
            "observations:integrity-only",
            "scheduling-errors:context-only",
        ],
        maxAbsoluteError=0.0,
        maxErrors={},
        operations=[],
    )

    def compare(a, b, path, call):
        if (
            isinstance(a, (int, float))
            and not isinstance(a, bool)
            and isinstance(b, (int, float))
            and not isinstance(b, bool)
        ):
            error = abs(a - b)
            report["maxAbsoluteError"] = max(report["maxAbsoluteError"], error)
            if a != b:
                report["exact"] = False
                report.setdefault(
                    "firstExactDifference",
                    dict(call=call, path=path, expected=a, actual=b),
                )
                field = re.sub(r"^trajectory\.\d+\.", "", path)
                report["maxErrors"][field] = max(
                    report["maxErrors"].get(field, 0), error
                )
            discrete = re.search(
                r"(^|\.)(steps|step|index|state_index|groupCounter|body|condim|type)(\.|$)",
                path,
            )
            if math.isfinite(error) and error <= (
                0 if discrete else atol + rtol * abs(a)
            ):
                return True
        elif isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
            return all(
                [
                    compare(x, y, path + "." + str(i), call)
                    for i, (x, y) in enumerate(zip(a, b))
                ]
            )
        elif isinstance(a, dict) and isinstance(b, dict) and a.keys() == b.keys():
            return all([compare(a[k], b[k], path + "." + k, call) for k in sorted(a)])
        elif type(a) == type(b) and a == b:
            return True
        report["exact"] = False
        report.setdefault(
            "firstExactDifference", dict(call=call, path=path, expected=a, actual=b)
        )
        report.setdefault(
            "firstDifference", dict(call=call, path=path, expected=a, actual=b)
        )
        return False

    try:
        if (
            mode not in ("continuous", "operation")
            or not math.isfinite(atol)
            or not math.isfinite(rtol)
            or atol < 0
            or rtol < 0
        ):
            raise ValueError("Invalid verification mode or tolerances")
        validate(ep)
        for key, data in ep["assets"].items():
            expected = ep["manifest"]["hashes"].get(
                "world/" + key, ep["manifest"]["hashes"].get(key)
            )
            if expected and expected != digest(data):
                raise ValueError("World checksum mismatch")
        runtime = Runtime(as_initial(ep, preserve_id=True))
        for c in ep.get("calls", []):
            if c.get("error_code") == "busy":
                positions = {
                    (e["call_id"], e["kind"]): i for i, e in enumerate(ep["events"])
                }
                request, complete = (
                    positions[(c["id"], "request")],
                    positions[(c["id"], "complete")],
                )
                overlapping = any(
                    other["id"] != c["id"]
                    and positions[(other["id"], "request")] < request
                    and positions[(other["id"], "complete")] > complete
                    for other in ep.get("calls", [])
                )
                if not overlapping or c["steps"] or c["trace_start"] != c["trace_end"]:
                    raise ValueError("Invalid busy event context")
            if c["name"] == "capture_scene" or c.get("error_code") == "busy":
                runtime.episode["calls"].append(clone(c))
                continue
            if mode == "operation":
                runtime.restore(
                    ep["states"][c["before_index"] - 1]
                    if c["before_index"]
                    else ep["initial"]
                )
                runtime.episode["states"] = clone(ep["states"][: c["before_index"]])
            runtime.cancel_at_step = c.get("cancellation", {}).get("step")
            try:
                runtime.execute(c["name"], c["arguments"], c["actor"])
            except Exception:
                pass
            actual = runtime.episode["calls"][-1]
            if actual["id"] != c["id"]:
                report.update(status="failed", error="Missing replay call")
                break

            def frame(f):
                return {
                    k: f[k]
                    for k in (
                        "integration",
                        "camera",
                        "groups",
                        "groupCounter",
                        "phase",
                        "step",
                        "sim_time",
                        "applied",
                    )
                    if k in f
                }

            expected_trace = [
                frame(f) for f in ep["trajectory"][c["trace_start"] : c["trace_end"]]
            ]
            actual_trace = [
                frame(f)
                for f in runtime.episode["trajectory"][
                    actual["trace_start"] : actual["trace_end"]
                ]
            ]
            ok = compare(expected_trace, actual_trace, "trajectory", c["index"])
            for key in ("status", "error_code", "steps", "sim_end", "state_index"):
                ok = compare(c.get(key), actual.get(key), key, c["index"]) and ok
            if c["status"] == "completed":
                ok = (
                    compare(c.get("result"), actual.get("result"), "result", c["index"])
                    and ok
                )
            report["operations"].append(
                dict(
                    call=c["index"],
                    expectedSteps=c["steps"],
                    actualSteps=actual["steps"],
                    expectedStop=c.get(
                        "error_code",
                        (c.get("result") or {}).get("physics")
                        if isinstance(c.get("result"), dict)
                        else None,
                    ),
                    actualStop=actual.get(
                        "error_code",
                        (actual.get("result") or {}).get("physics")
                        if isinstance(actual.get("result"), dict)
                        else None,
                    ),
                )
            )
            report["checked"] += 1
            if not ok:
                report["status"] = "diverged"
                report["failureKind"] = (
                    "numerical"
                    if isinstance(report["firstDifference"]["expected"], (int, float))
                    and isinstance(report["firstDifference"]["actual"], (int, float))
                    else "semantic"
                )
                break
    except Exception as e:
        report["failureKind"] = (
            "capability"
            if "capability" in str(e).lower()
            else "invalid_archive"
            if any(
                x in str(e).lower()
                for x in (
                    "schema",
                    "checksum",
                    "observation",
                    "frame",
                    "event",
                    "archive",
                )
            )
            else "incompatible"
            if any(x in str(e).lower() for x in ("layout", "contract", "incompatible"))
            else "execution"
        )
        report.update(
            status="incompatible"
            if any(
                x in str(e).lower()
                for x in ("incompatible", "layout", "contract", "capability")
            )
            else "failed",
            error=str(e),
        )
    return report
