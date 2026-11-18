import {
  BoxGeometry,
  type BufferGeometry,
  ConeGeometry,
  CylinderGeometry,
  EdgesGeometry,
  Euler,
  Group,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  Quaternion,
  SphereGeometry,
  Vector3,
} from '@iwsdk/core';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Batches props authored in room metres (x east, y up, z south) into one
 * mesh plus one set of outline edges per colour, scaled onto the model.
 * Two draw calls per colour, however many pieces.
 */
export class PropBatch {
  private readonly faces: BufferGeometry[] = [];
  private readonly edges: BufferGeometry[] = [];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly e = new Euler();
  private readonly v = new Vector3();
  private readonly one = new Vector3(1, 1, 1);

  /** Adds a piece centred at (x, y, z) in room metres, turned by ry about the vertical. */
  add(geo: BufferGeometry, x: number, y: number, z: number, ry = 0, outline = true, rx = 0, rz = 0) {
    this.m.compose(this.v.set(x, y, z), this.q.setFromEuler(this.e.set(rx, ry, rz)), this.one);
    geo.applyMatrix4(this.m);
    this.faces.push(geo);
    if (outline) this.edges.push(new EdgesGeometry(geo, 25));
    return this;
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, ry = 0) {
    return this.add(new BoxGeometry(w, h, d), x, y, z, ry);
  }

  cyl(r: number, h: number, x: number, y: number, z: number, seg = 16, rx = 0, rz = 0) {
    return this.add(new CylinderGeometry(r, r, h, seg), x, y, z, 0, true, rx, rz);
  }

  ball(r: number, x: number, y: number, z: number) {
    return this.add(new SphereGeometry(r, 12, 8), x, y, z, 0, false);
  }

  /** Builds the batch onto the model: scale room metres by s, then offset. */
  build(s: number, offX: number, offZ: number, faceMat: Material, edgeMat: Material): Group {
    const g = new Group();
    const place = new Matrix4().makeTranslation(offX, 0, offZ).multiply(new Matrix4().makeScale(s, s, s));
    if (this.faces.length) {
      const faces = mergeGeometries(this.faces);
      faces.applyMatrix4(place);
      g.add(new Mesh(faces, faceMat));
    }
    if (this.edges.length) {
      const edges = mergeGeometries(this.edges);
      edges.applyMatrix4(place);
      g.add(new LineSegments(edges, edgeMat));
    }
    return g;
  }
}

/** The gallery's furniture, in room metres. Cover props sit beside their spots. */
export function galleryProps(): PropBatch {
  const p = new PropBatch();
  // Curtains on the west wall: a zigzag of folds under a rod (spot: 1.0, 1.8).
  for (let i = 0; i < 5; i++) p.box(0.07, 1.15, 0.38, i % 2 ? 0.3 : 0.18, 0.575, 1.0 + i * 0.34, i % 2 ? 0.45 : -0.45);
  p.cyl(0.025, 2.0, 0.22, 1.2, 1.7, 8, Math.PI / 2);
  // Plinth with a bust (spot: 3.6, 4.4).
  p.box(0.6, 0.9, 0.6, 4.15, 0.45, 4.15).box(0.7, 0.06, 0.7, 4.15, 0.93, 4.15);
  p.box(0.42, 0.16, 0.24, 4.15, 1.04, 4.15).cyl(0.07, 0.12, 4.15, 1.17, 4.15, 10).ball(0.14, 4.15, 1.33, 4.15);
  // Pillar with base and capital (spot: 6.0, 3.0).
  p.box(0.8, 0.14, 0.8, 6.65, 0.07, 3.0).cyl(0.3, 1.25, 6.65, 0.765, 3.0, 16).box(0.8, 0.14, 0.8, 6.65, 1.46, 3.0);
  // Sofa: seat, a high back on the south side, arms (spot: 8.6, 5.2).
  p.box(2.0, 0.42, 0.8, 8.6, 0.21, 4.5).box(2.0, 0.55, 0.18, 8.6, 0.68, 4.86);
  p.box(0.2, 0.62, 0.8, 7.5, 0.31, 4.5).box(0.2, 0.62, 0.8, 9.7, 0.31, 4.5);
  // Window frame in the west wall gap.
  p.box(0.12, 1.0, 0.08, 0, 0.5, 3.4).box(0.12, 1.0, 0.08, 0, 0.5, 4.6);
  p.box(0.16, 0.06, 1.3, 0, 0.3, 4.0).box(0.16, 0.06, 1.3, 0, 0.98, 4.0).box(0.05, 0.66, 0.04, 0, 0.64, 4.0);
  // Hall door frame in the south wall gap.
  p.box(0.1, 1.0, 0.14, 5.4, 0.5, 8.0).box(0.1, 1.0, 0.14, 6.6, 0.5, 8.0).box(1.3, 0.08, 0.14, 6.0, 0.98, 8.0);
  // Stanchions either side of the Blue Kite, roped back to the wall.
  for (const z of [2.75, 4.45]) {
    p.cyl(0.035, 0.85, 11.2, 0.43, z, 8).ball(0.07, 11.2, 0.9, z).cyl(0.14, 0.03, 11.2, 0.015, z, 12);
    p.add(new CylinderGeometry(0.015, 0.015, 0.82, 6), 11.6, 0.8, z, 0, false, 0, Math.PI / 2 + 0.25);
  }
  // A rug under the sofa and a runner by the door, as flat outlines.
  p.add(new BoxGeometry(3.2, 0.005, 2.0), 8.6, 0.003, 4.6, 0, true);
  p.add(new BoxGeometry(1.2, 0.005, 0.8), 6.0, 0.003, 7.4, 0, true);
  return p;
}

/** The fuse box Rook has to cut (spot: 4.0, 0.6). */
export function fuseProps(): PropBatch {
  return new PropBatch().box(0.55, 0.7, 0.14, 4.0, 0.62, 0.09).box(0.05, 0.22, 0.06, 4.22, 0.62, 0.19).cyl(0.03, 0.42, 4.0, 1.18, 0.07, 6);
}

/** The Eye: a wall camera, built facing +x so it can turn with its sweep. */
export function eyeProps(): PropBatch {
  return new PropBatch()
    .box(0.36, 0.16, 0.16, 0.05, 0, 0)
    .cyl(0.065, 0.08, 0.26, 0, 0, 12, 0, Math.PI / 2)
    .box(0.05, 0.2, 0.05, -0.08, 0.1, 0);
}

/**
 * Halloran's furniture, in room metres. Cover props sit beside their spots;
 * the panel, breaker, lasers, vault door and the Heron are built separately.
 */
export function halloranProps(): PropBatch {
  const p = new PropBatch();
  // Loading bay: stacked crates (spot: 2.8, 7.4), a pallet and the roller door's frame.
  p.box(0.9, 0.9, 0.9, 3.45, 0.45, 6.95).box(0.7, 0.6, 0.7, 3.45, 1.2, 6.95).box(0.8, 0.7, 0.8, 2.35, 0.35, 6.95);
  p.box(1.2, 0.14, 1.0, 1.6, 0.07, 11.2).box(0.8, 0.6, 0.7, 1.6, 0.44, 11.2);
  p.box(0.12, 1.0, 0.14, 0, 0.5, 9.0).box(0.12, 1.0, 0.14, 0, 0.5, 10.2).box(0.16, 0.1, 1.4, 0, 0.98, 9.6);
  // Saleroom: two rows of chairs (spot: 6.9, 8.9), the rostrum (spot: 9.4, 11.0), an easel (spot: 11.4, 8.2) and lots on plinths.
  for (const z of [8.55, 9.3])
    for (let i = 0; i < 5; i++) {
      const x = 7.5 + i * 0.55;
      p.box(0.44, 0.06, 0.42, x, 0.45, z).box(0.44, 0.42, 0.05, x, 0.69, z + 0.2);
    }
  p.box(1.1, 1.1, 0.6, 9.95, 0.55, 11.4).box(1.2, 0.06, 0.7, 9.95, 1.13, 11.4);
  p.add(new BoxGeometry(0.06, 1.5, 0.06), 11.75, 0.72, 7.85, 0, true, 0.18, 0);
  p.add(new BoxGeometry(0.06, 1.5, 0.06), 11.95, 0.72, 7.85, 0, true, 0.18, 0);
  p.add(new BoxGeometry(0.06, 1.4, 0.06), 11.85, 0.7, 8.35, 0, true, -0.22, 0);
  p.box(0.7, 0.55, 0.05, 11.85, 1.05, 7.9);
  for (const [x, z] of [[13.4, 9.4], [15.2, 9.4], [13.4, 10.6]]) p.box(0.5, 1.0, 0.5, x, 0.5, z).cyl(0.12, 0.3, x, 1.15, z, 10);
  // Corridor: a tall cabinet (spot: 1.0, 5.5), a bench (spot: 5.6, 5.6) and a bronze on its pedestal (spot: 10.4, 5.0).
  p.box(0.45, 1.6, 1.0, 0.3, 0.8, 5.5);
  p.box(1.4, 0.45, 0.45, 5.6, 0.22, 6.2);
  p.box(0.6, 1.0, 0.6, 10.95, 0.5, 4.85).cyl(0.13, 0.55, 10.95, 1.28, 4.85, 10).ball(0.12, 10.95, 1.65, 4.85);
  // Store room: shelving (spot: 1.3, 1.6) and boxes.
  p.box(0.5, 1.9, 1.7, 0.35, 0.95, 1.6).box(1.6, 1.9, 0.5, 1.7, 0.95, 0.3);
  for (const y of [0.5, 1.0, 1.5]) p.box(0.52, 0.04, 1.72, 0.35, y, 1.6);
  p.box(0.6, 0.5, 0.6, 3.2, 0.25, 0.6).box(0.5, 0.4, 0.5, 3.2, 0.7, 0.6);
  // Security office: the desk with its monitors (spot: 7.4, 2.0) and a filing cabinet.
  p.box(1.7, 0.75, 0.8, 7.4, 0.375, 2.65).box(0.5, 0.35, 0.06, 7.0, 0.93, 2.85).box(0.5, 0.35, 0.06, 7.65, 0.93, 2.85);
  p.box(0.5, 1.3, 0.6, 11.6, 0.65, 3.8);
  // Vault hall: the two key posts on the north wall.
  for (const x of [13.6, 17.2]) p.box(0.3, 1.15, 0.22, x, 0.57, 4.62).box(0.16, 0.16, 0.06, x, 0.95, 4.76);
  // Vault: the Heron's case on its plinth (spot: 14.0, 1.8), deposit boxes along the east wall (spot: 17.0, 1.3).
  p.box(0.7, 0.9, 0.7, 14.0, 0.45, 1.3);
  p.box(0.45, 2.0, 2.6, 17.75, 1.0, 1.4);
  for (let i = 1; i < 5; i++) p.box(0.47, 0.02, 2.62, 17.75, i * 0.4, 1.4);
  // Rugs, as flat outlines.
  p.add(new BoxGeometry(3.2, 0.005, 1.8), 8.6, 0.003, 8.9, 0, true);
  p.add(new BoxGeometry(6.0, 0.005, 1.0), 6.0, 0.003, 5.5, 0, true);
  return p;
}

/** The Gilded Heron: a gold bird a little over half a metre tall, facing +x. */
export function heronProps(): PropBatch {
  const p = new PropBatch();
  p.add(new CylinderGeometry(0.11, 0.13, 0.04, 14), 0, 0.02, 0, 0, false);
  for (const z of [-0.035, 0.035]) p.add(new CylinderGeometry(0.011, 0.011, 0.26, 6), 0, 0.17, z, 0, false);
  p.add(new SphereGeometry(0.12, 14, 10).scale(1.45, 0.75, 0.75), -0.02, 0.36, 0, 0, false, 0, -0.15);
  p.add(new CylinderGeometry(0.018, 0.026, 0.24, 8), 0.12, 0.5, 0, 0, false, 0, -0.55);
  p.add(new SphereGeometry(0.045, 10, 8), 0.2, 0.62, 0, 0, false);
  p.add(new ConeGeometry(0.014, 0.15, 8), 0.3, 0.6, 0, 0, false, 0, -Math.PI / 2 - 0.15);
  p.add(new ConeGeometry(0.05, 0.16, 8), -0.21, 0.33, 0, 0, false, 0, Math.PI / 2 + 0.35);
  return p;
}
