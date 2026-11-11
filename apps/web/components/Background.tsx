'use client';

import { useEffect, useRef } from 'react';

import { brand } from '@cashflow/shared';

const SPACING = 28;
const BASE_RADIUS = 1;
const WAVE_RADIUS = 0.9;
const POINTER_RADIUS = 3.2;
const REACH = 240;
const PUSH = 7;

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

const INK = rgb(brand.colors.ink);
const GOLD = rgb(brand.colors.brightGold);

/**
 * A halftone dot field printed on the paper. A slow swell drifts through it on its own, and
 * a warm gold light follows the cursor, pressing the nearby dots darker and nudging them
 * aside. Purely decorative: it sits behind the page, ignores input, and holds still when the
 * visitor prefers reduced motion.
 */
export function Background() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let frame = 0;
    // Pointer target, the eased light that chases it, and how lit the light is (0 to 1).
    const target = { x: 0, y: 0, on: false };
    const light = { x: 0, y: 0, level: 0 };

    function resize() {
      if (!canvas || !ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (still) draw(0);
    }

    function draw(ms: number) {
      if (!ctx) return;
      const t = ms / 1000;
      ctx.clearRect(0, 0, width, height);

      light.x += (target.x - light.x) * 0.12;
      light.y += (target.y - light.y) * 0.12;
      light.level += ((target.on ? 1 : 0) - light.level) * 0.06;
      const lit = light.level > 0.01;

      if (lit) {
        const glow = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, REACH * 1.3);
        glow.addColorStop(0, `rgba(${GOLD}, ${0.5 * light.level})`);
        glow.addColorStop(1, `rgba(${GOLD}, 0)`);
        ctx.fillStyle = glow;
        ctx.fillRect(light.x - REACH * 1.3, light.y - REACH * 1.3, REACH * 2.6, REACH * 2.6);
      }

      const cols = Math.ceil(width / SPACING) + 1;
      const rows = Math.ceil(height / SPACING) + 1;
      const offsetX = (width - (cols - 1) * SPACING) / 2;
      const offsetY = (height - (rows - 1) * SPACING) / 2;
      const near: number[] = [];

      // The resting field: one path, one fill. Only the dot size breathes.
      ctx.beginPath();
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = offsetX + col * SPACING;
          const y = offsetY + row * SPACING;
          const swell =
            Math.sin(x * 0.006 + y * 0.004 - t * 0.5) * 0.6 +
            Math.sin(x * -0.003 + y * 0.007 + t * 0.3) * 0.4;
          const r = BASE_RADIUS + WAVE_RADIUS * (0.5 + 0.5 * swell);

          if (lit) {
            const dx = x - light.x;
            const dy = y - light.y;
            const d = Math.hypot(dx, dy);
            if (d < REACH) {
              const f = (1 - d / REACH) ** 2 * light.level;
              const push = d > 0.001 ? (f * PUSH) / d : 0;
              near.push(x + dx * push, y + dy * push, r + f * POINTER_RADIUS, f);
              continue;
            }
          }
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      ctx.fillStyle = `rgba(${INK}, 0.16)`;
      ctx.fill();

      // Dots under the light: darker, larger, pushed away from the cursor.
      for (let i = 0; i < near.length; i += 4) {
        ctx.beginPath();
        ctx.arc(near[i]!, near[i + 1]!, near[i + 2]!, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${INK}, ${0.16 + 0.74 * near[i + 3]!})`;
        ctx.fill();
      }

      if (!still) frame = requestAnimationFrame(draw);
    }

    function onMove(event: PointerEvent) {
      if (event.pointerType === 'touch') return;
      if (!target.on && light.level < 0.01) {
        light.x = event.clientX;
        light.y = event.clientY;
      }
      target.x = event.clientX;
      target.y = event.clientY;
      target.on = true;
    }

    function onLeave() {
      target.on = false;
    }

    function onVisibility() {
      cancelAnimationFrame(frame);
      if (!document.hidden && !still) frame = requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener('resize', resize);
    if (!still) {
      window.addEventListener('pointermove', onMove, { passive: true });
      document.documentElement.addEventListener('pointerleave', onLeave);
      document.addEventListener('visibilitychange', onVisibility);
      frame = requestAnimationFrame(draw);
    }

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={ref} className="background" aria-hidden="true" />;
}
