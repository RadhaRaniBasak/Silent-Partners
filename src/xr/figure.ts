import {
  CapsuleGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  SphereGeometry,
} from '@iwsdk/core';
import { holoize } from './holo';

export type FigurePose = 'stand' | 'walk' | 'crouch' | 'work' | 'climb' | 'carry';

export interface FigureLook {
  color: string;
  /** White mark above the head, so the crew reads without colour. */
  badge: 'circle' | 'triangle' | null;
  hat: 'beanie' | 'ponytail' | 'cap';
  scale?: number;
  torch?: boolean;
}

const damp = (a: number, b: number, k: number, dt: number) => a + (b - a) * (1 - Math.exp(-k * dt));

/**
 * A little hologram person, 8.5 cm tall (1.7 m at 1:20), facing +x. Limbs
 * swing from hip and shoulder pivots; poses blend so a freeze reads as a
 * duck into cover and work reads as hands on the job.
 */
export class Figure {
  readonly group = new Group();
  readonly body = new Group();
  readonly ring: Mesh;
  shake = 0;
  private readonly chest = new Group();
  private readonly legs: Group[] = [];
  private readonly arms: Group[] = [];
  private phase = 0;
  private legA = 0;
  private armA = 0;
  private armBase = 0;
  private lean = 0;
  private drop = 0;
  private t = Math.random() * 10;
  private torchArm = false;

  constructor(look: FigureLook) {
    const k = look.scale ?? 1;
    const mat = holoize(new MeshStandardMaterial({ color: look.color, emissive: look.color, emissiveIntensity: 0.55, roughness: 0.6 }), 0.06);
    const dark = holoize(new MeshStandardMaterial({ color: new Color(look.color).multiplyScalar(0.35), emissive: look.color, emissiveIntensity: 0.12, roughness: 0.8 }), 0.06);
    const limb = (r: number, len: number, m = mat) => {
      const pivot = new Group();
      const mesh = new Mesh(new CapsuleGeometry(r, len, 3, 8), m);
      mesh.position.y = -(len / 2 + r);
      pivot.add(mesh);
      return pivot;
    };
    // Legs from the hips at 4 cm; the body group drops for a crouch.
    for (const side of [-1, 1]) {
      const leg = limb(0.0042, 0.0316, dark);
      leg.position.set(0, 0.04, side * 0.0046);
      this.legs.push(leg);
      this.body.add(leg);
    }
    this.chest.position.y = 0.04;
    this.body.add(this.chest);
    const torso = new Mesh(new CapsuleGeometry(0.0085, 0.013, 3, 10), mat);
    torso.position.y = 0.015;
    torso.scale.set(0.8, 1, 1);
    const head = new Mesh(new SphereGeometry(0.0078, 12, 10), mat);
    head.position.y = 0.0385;
    const nose = new Mesh(new SphereGeometry(0.0022, 6, 4), mat);
    nose.position.set(0.0074, 0.0375, 0);
    this.chest.add(torso, head, nose);
    for (const side of [-1, 1]) {
      const arm = limb(0.003, 0.02);
      arm.position.set(0, 0.026, side * 0.0108);
      this.arms.push(arm);
      this.chest.add(arm);
    }
    if (look.hat === 'beanie') {
      const beanie = new Mesh(new SphereGeometry(0.0083, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), dark);
      beanie.position.y = 0.0395;
      const brim = new Mesh(new CylinderGeometry(0.0084, 0.0084, 0.0026, 14), dark);
      brim.position.y = 0.0398;
      this.chest.add(beanie, brim);
    } else if (look.hat === 'ponytail') {
      const tail = new Mesh(new CapsuleGeometry(0.0024, 0.009, 3, 6), dark);
      tail.position.set(-0.008, 0.036, 0);
      tail.rotation.z = -0.5;
      const hair = new Mesh(new SphereGeometry(0.0081, 12, 6, 0, Math.PI * 2, 0, Math.PI * 0.45), dark);
      hair.position.y = 0.039;
      this.chest.add(tail, hair);
    } else {
      const crown = new Mesh(new CylinderGeometry(0.0074, 0.0082, 0.0062, 14), dark);
      crown.position.y = 0.0455;
      const peak = new Mesh(new CylinderGeometry(0.006, 0.006, 0.0012, 12, 1, false, -Math.PI / 2, Math.PI), dark);
      peak.position.set(0.0045, 0.0428, 0);
      this.chest.add(crown, peak);
    }
    if (look.torch) {
      // Held out ahead, along the arm, so it lines up with the light cone.
      const torch = new Mesh(new CylinderGeometry(0.0024, 0.0018, 0.011, 8), new MeshBasicMaterial({ color: '#ffe6a0', toneMapped: false }));
      torch.position.set(0, -0.03, 0);
      this.arms[1].add(torch);
      this.torchArm = true;
    }
    if (look.badge) {
      const g = new CircleGeometry(look.badge === 'circle' ? 0.0052 : 0.0068, look.badge === 'circle' ? 16 : 3);
      const badge = new Mesh(g, new MeshBasicMaterial({ color: '#ffffff', toneMapped: false }));
      badge.rotation.x = -Math.PI / 2;
      badge.position.y = 0.063;
      this.chest.add(badge);
    }
    // A soft contact shadow and a team ring keep tiny figures grounded.
    const shadow = new Mesh(new CircleGeometry(0.012, 16), new MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.45, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.0008;
    this.ring = new Mesh(
      new RingGeometry(0.0135, 0.0165, 28),
      new MeshBasicMaterial({ color: look.color, transparent: true, opacity: look.badge ? 0.7 : 0, depthWrite: false, toneMapped: false }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.0011;
    this.ring.visible = !!look.badge;
    this.body.scale.setScalar(k);
    this.group.add(this.body, shadow, this.ring);
  }

  /** Blends toward a pose; speed scales the stride. */
  update(pose: FigurePose, dt: number, speed = 1) {
    this.t += dt;
    // Negative speed walks backwards: the rewind plays the tape in reverse.
    const walking = (pose === 'walk' || pose === 'climb' || pose === 'carry') && speed !== 0;
    if (walking) this.phase += dt * 11 * speed;
    const swing = walking ? Math.sin(this.phase) : 0;
    const k = 14;
    this.legA = damp(this.legA, pose === 'crouch' ? 0.95 : swing * 0.55, k, dt);
    this.armBase = damp(this.armBase, pose === 'crouch' ? 0.75 : pose === 'work' ? 1.45 : pose === 'climb' ? 2.7 : pose === 'carry' ? 1.2 : 0, k, dt);
    this.armA = damp(this.armA, pose === 'work' ? Math.sin(this.t * 15) * 0.18 : pose === 'carry' || pose === 'climb' ? swing * 0.15 : -swing * 0.45, k, dt);
    this.lean = damp(this.lean, pose === 'crouch' ? -0.38 : pose === 'work' ? -0.16 : walking ? -0.06 : 0, k, dt);
    this.drop = damp(this.drop, pose === 'crouch' ? 0.016 : 0, k, dt);
    this.legs[0].rotation.z = this.legA;
    this.legs[1].rotation.z = pose === 'crouch' ? this.legA * 0.8 : -this.legA;
    this.arms[0].rotation.z = this.armBase + this.armA;
    this.arms[1].rotation.z = this.torchArm ? 1.35 : this.armBase - this.armA;
    this.chest.rotation.z = this.lean;
    const bob = walking ? Math.abs(Math.sin(this.phase)) * 0.0018 : pose === 'stand' ? Math.sin(this.t * 2) * 0.0004 : 0;
    this.body.position.y = bob - this.drop;
    if (this.shake > 0) {
      this.shake = Math.max(0, this.shake - dt);
      this.body.rotation.y = Math.sin(this.shake * 40) * 0.5 * (this.shake / 0.5);
    } else this.body.rotation.y = 0;
  }
}
