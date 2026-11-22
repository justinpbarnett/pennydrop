export const SIM_STEP = 1 / 240;

export interface Body {
  q: number[];
  v: number[];
}

export interface System {
  step: number;
  accel(q: readonly number[]): number[];
  damping?: number;
  rebound?(before: Body, after: Body, time: number): { fraction: number; body: Body } | null;
}

export type Stop = (before: Body, after: Body) => number | null;

export interface Leg {
  stop: Stop;
  maxSteps: number;
}

export interface Trajectory {
  dims: number;
  times: Float64Array;
  q: Float64Array;
  v: Float64Array;
  legEnds: number[];
}

export function advance(system: System, body: Body, dt: number): Body {
  const decay = Math.exp(-(system.damping ?? 0) * dt * 0.5);
  const v = body.v.map((value) => value * decay);
  const kick = (velocity: number[], position: readonly number[]) => system.accel(position).map((a, index) => velocity[index]! + a * dt * 0.5);
  const half = kick(v, body.q);
  const q = body.q.map((value, index) => value + half[index]! * dt);
  return { q, v: kick(half, q).map((value) => value * decay) };
}

export function integrate(system: System, start: Body, legs: ((from: Body) => Leg)[]): { trajectory: Trajectory; failed: number | null } {
  const times: number[] = [0];
  const q: number[] = [...start.q];
  const v: number[] = [...start.v];
  const legEnds: number[] = [];
  let body = start;
  let time = 0;
  let failed: number | null = null;
  legs.forEach((makeLeg, legIndex) => {
    if (failed !== null) return;
    const leg = makeLeg(body);
    let reached = false;
    for (let count = 0; count < leg.maxSteps && !reached; count++) {
      const advanced = advance(system, body, system.step);
      const touch = system.rebound?.(body, advanced, time) ?? null;
      const next = touch?.body ?? advanced;
      const used = system.step * (touch?.fraction ?? 1);
      const hit = leg.stop(body, next);
      if (hit === null) {
        body = next;
        time += used;
      } else {
        body = hit >= 1 ? next : advance(system, body, used * hit);
        time += used * hit;
        reached = true;
      }
      times.push(time);
      q.push(...body.q);
      v.push(...body.v);
    }
    if (!reached) failed = legIndex;
    legEnds.push(times.length - 1);
  });
  return { trajectory: { dims: start.q.length, times: Float64Array.from(times), q: Float64Array.from(q), v: Float64Array.from(v), legEnds }, failed };
}

export function sampleCount(trajectory: Trajectory): number {
  return trajectory.times.length;
}

export function endTime(trajectory: Trajectory): number {
  return trajectory.times[trajectory.times.length - 1]!;
}

export function legStart(trajectory: Trajectory, leg: number): number {
  return leg === 0 ? 0 : trajectory.times[trajectory.legEnds[leg - 1]!]!;
}

function slot(trajectory: Trajectory, time: number): { index: number; fraction: number } {
  const { times } = trajectory;
  if (time <= 0) return { index: 0, fraction: 0 };
  if (time >= times[times.length - 1]!) return { index: times.length - 2, fraction: 1 };
  let low = 0;
  let high = times.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (times[middle]! <= time) low = middle;
    else high = middle;
  }
  return { index: low, fraction: (time - times[low]!) / (times[high]! - times[low]!) };
}

export function bodyAt(trajectory: Trajectory, time: number): Body {
  if (trajectory.times.length === 1) return { q: [...trajectory.q], v: [...trajectory.v] };
  const { index, fraction } = slot(trajectory, time);
  const { dims } = trajectory;
  const mix = (data: Float64Array) => Array.from({ length: dims }, (_, dim) => {
    const from = data[index * dims + dim]!;
    return from + (data[(index + 1) * dims + dim]! - from) * fraction;
  });
  return { q: mix(trajectory.q), v: mix(trajectory.v) };
}

export function timesBetween(from: number, to: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => from + ((to - from) * index) / (count - 1));
}
