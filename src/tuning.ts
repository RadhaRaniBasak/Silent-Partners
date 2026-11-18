/**
 * Every tuning value in one place. Room values are in metres and seconds at
 * room scale (the gallery is 12 m by 8 m); model values are in metres on the
 * table, where the gallery is 1:20. Change a value, hot-reload, playtest.
 */
export const DEG = Math.PI / 180;

export const T = {
  // Simulation
  step: 1 / 60,
  thiefSpeed: 1.2,
  carrySpeed: 0.8,
  creepSpeed: 0.15,
  bertSpeed: 1.35,
  bertSpeedAssist: 0.95,
  torchRange: 4.2,
  torchHalfDeg: 25,
  torchTurnDegPerS: 360,
  bertTurnS: 0.8,
  bertFlickerS: 0.5,
  bertLookS: 2.0,
  /** Footsteps: Bert hears a walking partner this close (m), unless he can already see them. */
  hear: 2.0,
  hearAssist: 1.5,
  /** Carrying the painting is louder. */
  hearCarry: 1.15,
  /** Seconds he stands turned toward a sound, then before another can draw him. */
  listenS: 1.8,
  deafS: 2.5,
  eyePeriod: 8,
  eyePeriodAssist: 11,
  eyeSweepDeg: 30,
  eyeHalfDeg: 12,
  eyeRange: 8,
  /** Eye phase when it wakes in beat 2: beam on Lark's route, turning away. */
  eyeWakePhase: 0.53,
  coverRadius: 0.5,
  arriveRadius: 0.05,
  fillActiveS: 0.8,
  fillActiveAssistS: 1.2,
  fillStillOpenS: 3.0,
  fillStillOpenAssistS: 4.5,
  drainS: 2.0,
  suspiciousAt: 0.5,
  calmAt: 0.25,
  climbS: 1.5,
  cutS: 2.5,
  unlockS: 3.0,
  liftS: 2.0,

  // Job 2
  /** In a lit room a guard sees farther and wider than by torch. */
  litRange: 5.6,
  litHalfDeg: 32,
  /** Investigating: walk over, stop short, sweep the torch, walk back. */
  investigateSpeed: 1.1,
  searchStop: 0.7,
  searchS: 2.5,
  searchSweepDeg: 50,
  listenSmartS: 0.9,
  /** The vault's motion sensor: rests, blinks a warning, then arms. */
  sensorPeriod: 6,
  sensorRestS: 3.6,
  sensorWarnS: 0.6,
  sensorFillS: 0.2,
  laserWidth: 0.15,
  coins: 3,
  tossRange: 7,
  tossS: 0.6,
  coinHear: 6,
  powerS: 3.0,
  lightsS: 2.0,
  keysS: 1.5,
  crackS: 3.5,
  /** A checkpoint needs both partners still in cover this long. */
  checkpointS: 1.0,
  liftWindowMs: 1000,
  rewindS: 1.5,
  scanS: 4,

  // Recognition (feature mapping, matching, confirm times)
  curlOpenRatio: 2.0,
  curlFistRatio: 1.1,
  thumbInRatio: 0.5,
  thumbOutRatio: 0.9,
  accept: 0.3,
  margin: 0.1,
  confirmMs: { fist: 100, point: 150, thumb: 200, two: 220 } as Record<string, number>,
  releaseMs: 80,
  pauseMs: 600,
  pinchMs: 300,
  aimDwellMs: 150,
  palmUpCos: 0.707,

  // Aim and command zone (model metres)
  modelScale: 1 / 20,
  pickRadius: 0.06,
  stickRadius: 0.08,
  aimSmooth: 0.35,
  zoneAbove: 0.05,
  zoneMargin: 0.2,
  zoneAhead: 0.15,
  edgeSideDeg: 45,
  edgeVertDeg: 40,

  // Placement (metres)
  tableBelowEyes: 0.25,
  /** Mixed reality: lower still, toward a real desk's height for a seated player. */
  mixedExtraDrop: 0.17,
  tableDistance: 0.55,
  tableW: 0.8,
  tableD: 0.6,
  tableStep: 0.05,

  // Hints (seconds and counts)
  hintBrightenS: 10,
  hintGhostS: 20,
  failHintAfter: 3,
  assistOfferAfter: 5,
};
