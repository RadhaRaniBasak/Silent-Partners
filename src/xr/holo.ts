import { type Material, Matrix4 } from '@iwsdk/core';

/** Uniforms shared by every hologram material; the view updates them each frame. */
export const HOLO = {
  uTime: { value: 0 },
  /** 0..1: the whole model blushes red when someone is spotted. */
  uAlarm: { value: 0 },
  /** Model-space x of the scan front. Far past the room = fully drawn. */
  uReveal: { value: 10 },
  /** World to hologram space, so effects line up across every object. */
  uHoloInv: { value: new Matrix4() },
};

/**
 * Makes a basic, standard or line material read as a projection: drawn in
 * behind the scan front, faint scanlines drifting upward, a slight flicker,
 * and a red alarm tint. One program per material type, shared by all.
 */
export function holoize<M extends Material>(m: M, scanlines = 0.16): M {
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, HOLO);
    shader.uniforms.uLines = { value: scanlines };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform mat4 uHoloInv;\nvarying vec3 vHolo;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvHolo = (uHoloInv * modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uAlarm;\nuniform float uReveal;\nuniform float uLines;\nvarying vec3 vHolo;')
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
        float hScan = 1.0 - uLines + uLines * sin(vHolo.y * 1400.0 - uTime * 5.0);
        float hFlick = 0.975 + 0.025 * sin(uTime * 43.0) * sin(uTime * 17.0);
        float hEdge = (1.0 - smoothstep(0.0, 0.014, abs(vHolo.x - uReveal))) * step(uReveal, 1.0);
        float hLum = dot(gl_FragColor.rgb, vec3(0.3, 0.5, 0.2));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.22, 0.2) * (0.5 + hLum), uAlarm * 0.7);
        gl_FragColor.rgb = gl_FragColor.rgb * hScan * hFlick + vec3(0.55, 0.9, 1.0) * hEdge;
        gl_FragColor.a *= smoothstep(uReveal + 0.004, uReveal - 0.004, vHolo.x);`,
      );
  };
  return m;
}
