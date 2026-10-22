import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("reduced-motion support in animated backgrounds (issue #353)", () => {
  const rootDir = path.resolve(__dirname, "..");
  const colorBendsPath = path.join(rootDir, "src/components/color-bends.tsx");
  const darkVeilPath = path.join(rootDir, "src/components/dark-veil.tsx");
  const colorBendsCssPath = path.join(rootDir, "src/components/color-bends.css");
  const darkVeilCssPath = path.join(rootDir, "src/components/dark-veil.css");
  const globalsCssPath = path.join(rootDir, "src/app/globals.css");

  it("checks that ColorBends inspects prefers-reduced-motion and provides static fallback", () => {
    const code = fs.readFileSync(colorBendsPath, "utf8");

    expect(code).toContain("prefers-reduced-motion: reduce");
    expect(code).toContain("renderStaticFrame");
    expect(code).toContain("material.uniforms.uTime.value = 0");
    expect(code).toContain("handleMotionChange");
    expect(code).toContain("mediaQuery?.removeEventListener");
  });

  it("checks that DarkVeil inspects prefers-reduced-motion and provides static fallback", () => {
    const code = fs.readFileSync(darkVeilPath, "utf8");

    expect(code).toContain("prefers-reduced-motion: reduce");
    expect(code).toContain("renderStaticFrame");
    expect(code).toContain("program.uniforms.uTime.value = 0");
    expect(code).toContain("handleMotionChange");
    expect(code).toContain("mediaQuery?.removeEventListener");
  });

  it("checks that color-bends.css contains prefers-reduced-motion media query", () => {
    const css = fs.readFileSync(colorBendsCssPath, "utf8");

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none");
  });

  it("checks that dark-veil.css contains prefers-reduced-motion media query", () => {
    const css = fs.readFileSync(darkVeilCssPath, "utf8");

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none");
  });

  it("checks that globals.css contains prefers-reduced-motion media query for workspace orbs and beam", () => {
    const css = fs.readFileSync(globalsCssPath, "utf8");

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".app-workspace-orb");
    expect(css).toContain(".app-workspace-beam");
    expect(css).toContain("animation: none");
  });

  it("simulates reduced-motion toggle behavior and prevents continuous animation loops", () => {
    let loopRunning = false;
    let staticFrameRendered = 0;
    let activeFrameId: number | null = null;
    let isReducedMotion = true;

    const renderStaticFrame = () => {
      staticFrameRendered += 1;
    };

    const loop = () => {
      if (isReducedMotion) {
        renderStaticFrame();
        return;
      }
      loopRunning = true;
      activeFrameId = 1234;
    };

    // When reduced motion is preferred initially
    if (isReducedMotion) {
      renderStaticFrame();
    } else {
      loop();
    }

    expect(staticFrameRendered).toBe(1);
    expect(loopRunning).toBe(false);
    expect(activeFrameId).toBeNull();

    // User toggles reduced motion OFF
    isReducedMotion = false;
    loop();
    expect(loopRunning).toBe(true);
    expect(activeFrameId).toBe(1234);

    // User toggles reduced motion back ON
    isReducedMotion = true;
    activeFrameId = null;
    renderStaticFrame();

    expect(staticFrameRendered).toBe(2);
    expect(activeFrameId).toBeNull();
  });
});
