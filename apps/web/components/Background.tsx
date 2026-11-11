'use client';

import { useEffect, useRef } from 'react';

import { brand } from '@cashflow/shared';

const SPACING = 28;
const BASE_RADIUS = 1;
const WAVE_RADIUS = 0.9;
const POINTER_RADIUS = 3.2;
const REACH = 240;
const PUSH = 7;
/** Elements marked `data-quiet` keep the field clear behind them, fading in over this margin. */
const QUIET_PAD = 14;
const QUIET_FEATHER = 44;
/** A click sends a ring through the field: speed in px per second, width in px, life in seconds. */
const RIPPLE_SPEED = 620;
const RIPPLE_BAND = 70;
const RIPPLE_LIFE = 1.5;
const MAX_RIPPLES = 5;

function rgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
}

const INK = rgb(brand.colors.ink);
const GOLD = rgb(brand.colors.brightGold);

/**
 * A halftone dot field printed on the paper. A slow swell drifts through it on its own, and
 * a warm gold light follows the cursor, pressing the nearby dots darker and nudging them
 * aside. A click or tap makes the light flare and sends a ring out through the dots. The
 * field thins to nothing behind any element marked `data-quiet`, so body copy stays easy to
 * read. Purely decorative: it sits behind the page, never blocks input, and holds still when
 * the visitor prefers reduced motion.
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
    const light = { x: 0, y: 0, level: 0, flare: 0 };
    const ripples: { x: number; y: number; born: number }[] = [];
    let quiet: DOMRect[] = [];
    let now = 0;

    /** 0 inside a quiet zone, rising to 1 once clear of its feathered edge. */
    function clearOfText(x: number, y: number): number {
      let clear = 1;
      for (const zone of quiet) {
        const dx = Math.max(zone.left - QUIET_PAD - x, 0, x - zone.right - QUIET_PAD);
        const dy = Math.max(zone.top - QUIET_PAD - y, 0, y - zone.bottom - QUIET_PAD);
        clear = Math.min(clear, Math.hypot(dx, dy) / QUIET_FEATHER);
      }
      return clear;
    }

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
      now = t;
      ctx.clearRect(0, 0, width, height);
      quiet = Array.from(document.querySelectorAll('[data-quiet]'), (el) =>
        el.getBoundingClientRect(),
      );
      while (ripples.length > 0 && t - ripples[0]!.born > RIPPLE_LIFE) ripples.shift();

      light.x += (target.x - light.x) * 0.12;
      light.y += (target.y - light.y) * 0.12;
      light.level += ((target.on ? 1 : 0) - light.level) * 0.06;
      light.flare *= 0.94;
      const level = Math.min(1, Math.max(light.level, light.flare));
      const lit = level > 0.01;
      const active = lit || ripples.length > 0;

      if (lit) {
        const size = REACH * (1.3 + 0.5 * light.flare);
        const glow = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, size);
        glow.addColorStop(0, `rgba(${GOLD}, ${Math.min(0.8, 0.5 * level + 0.3 * light.flare)})`);
        glow.addColorStop(1, `rgba(${GOLD}, 0)`);
        ctx.fillStyle = glow;
        ctx.fillRect(light.x - size, light.y - size, size * 2, size * 2);
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
          const clear = quiet.length > 0 ? clearOfText(x, y) : 1;
          if (clear <= 0) continue;
          const r = (BASE_RADIUS + WAVE_RADIUS * (0.5 + 0.5 * swell)) * Math.min(1, clear);

          if (active) {
            // Strongest pull on this dot, from the light or from a passing ring.
            let f = 0;
            let px = 0;
            let py = 0;
            if (lit) {
              const dx = x - light.x;
              const dy = y - light.y;
              const d = Math.hypot(dx, dy);
              if (d < REACH) {
                f = (1 - d / REACH) ** 2 * level;
                if (d > 0.001) {
                  px = dx / d;
                  py = dy / d;
                }
              }
            }
            for (const ripple of ripples) {
              const age = t - ripple.born;
              const dx = x - ripple.x;
              const dy = y - ripple.y;
              const d = Math.hypot(dx, dy);
              const off = Math.abs(d - age * RIPPLE_SPEED);
              if (off >= RIPPLE_BAND) continue;
              const g = (1 - off / RIPPLE_BAND) * (1 - age / RIPPLE_LIFE) ** 2 * 0.8;
              if (g > f) {
                f = g;
                px = d > 0.001 ? dx / d : 0;
                py = d > 0.001 ? dy / d : 0;
              }
            }
            if (f > 0.004) {
              f *= Math.min(1, clear);
              near.push(x + px * f * PUSH, y + py * f * PUSH, r + f * POINTER_RADIUS, f);
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

    function onDown(event: PointerEvent) {
      if (ripples.length >= MAX_RIPPLES) ripples.shift();
      ripples.push({ x: event.clientX, y: event.clientY, born: now });
      // A tap has no cursor to follow, so the light jumps to it and fades on its own.
      if (event.pointerType === 'touch' || light.level < 0.01) {
        light.x = event.clientX;
        light.y = event.clientY;
        target.x = event.clientX;
        target.y = event.clientY;
      }
      light.flare = 1;
    }

    function onVisibility() {
      cancelAnimationFrame(frame);
      if (!document.hidden && !still) frame = requestAnimationFrame(draw);
    }

    resize();
    window.addEventListener('resize', resize);
    if (!still) {
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerdown', onDown, { passive: true });
      document.documentElement.addEventListener('pointerleave', onLeave);
      document.addEventListener('visibilitychange', onVisibility);
      frame = requestAnimationFrame(draw);
    }

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return <canvas ref={ref} className="background" aria-hidden="true" />;
}
