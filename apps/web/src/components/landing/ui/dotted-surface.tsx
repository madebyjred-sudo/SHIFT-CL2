import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";
import * as THREE from "three";

type DottedSurfaceProps = Omit<React.HTMLAttributes<HTMLDivElement>, "ref"> & {
  /** Color of the dots in CSS (defaults to cl2-ink ~ #2a1f1c). */
  dotColor?: { r: number; g: number; b: number };
  /** Animation speed multiplier. Lower = slower & more sutile. Default 0.02 */
  speed?: number;
  /** Wave amplitude in world units. Default 26 */
  amplitude?: number;
  /** Dot opacity 0–1. Default 0.32 */
  opacity?: number;
  /** Dot size. Default 5 */
  dotSize?: number;
};

export function DottedSurface({
  className,
  dotColor = { r: 60, g: 35, b: 30 },
  speed = 0.02,
  amplitude = 26,
  opacity = 0.32,
  dotSize = 5,
  ...props
}: DottedSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    animationId: number;
    cleanup: () => void;
  } | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const SEPARATION = 110;
    const AMOUNTX = 65;
    const AMOUNTY = 90;

    const getSize = () => ({
      w: container.clientWidth || window.innerWidth,
      h: container.clientHeight || window.innerHeight,
    });
    let { w, h } = getSize();

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(55, w / h, 1, 10000);
    camera.position.set(0, 180, 900);
    camera.lookAt(0, 0, 0);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const positions: number[] = [];
    const colors: number[] = [];
    for (let ix = 0; ix < AMOUNTX; ix++) {
      for (let iy = 0; iy < AMOUNTY; iy++) {
        const x = ix * SEPARATION - (AMOUNTX * SEPARATION) / 2;
        const z = iy * SEPARATION - (AMOUNTY * SEPARATION) / 2;
        positions.push(x, 0, z);
        colors.push(dotColor.r / 255, dotColor.g / 255, dotColor.b / 255);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
      size: dotSize,
      vertexColors: true,
      transparent: true,
      opacity,
      sizeAttenuation: true,
    });

    const points = new THREE.Points(geometry, material);
    scene.add(points);

    let count = 0;
    let animationId = 0;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const animate = () => {
      animationId = requestAnimationFrame(animate);
      const pos = geometry.attributes.position.array as Float32Array;
      let i = 0;
      for (let ix = 0; ix < AMOUNTX; ix++) {
        for (let iy = 0; iy < AMOUNTY; iy++) {
          const idx = i * 3;
          pos[idx + 1] =
            Math.sin((ix + count) * 0.3) * amplitude +
            Math.sin((iy + count) * 0.5) * amplitude;
          i++;
        }
      }
      geometry.attributes.position.needsUpdate = true;
      renderer.render(scene, camera);
      if (!reduce) count += speed;
    };

    const handleResize = () => {
      const s = getSize();
      w = s.w;
      h = s.h;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    animate();

    const cleanup = () => {
      window.removeEventListener("resize", handleResize);
      cancelAnimationFrame(animationId);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (renderer.domElement.parentNode === container) {
        container.removeChild(renderer.domElement);
      }
    };

    sceneRef.current = { renderer, animationId, cleanup };

    return () => {
      cleanup();
      sceneRef.current = null;
    };
  }, [dotColor.r, dotColor.g, dotColor.b, speed, amplitude, opacity, dotSize]);

  return (
    <div
      ref={containerRef}
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
      {...props}
    />
  );
}
