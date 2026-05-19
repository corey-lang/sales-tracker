import Image from "next/image";

// Brand logo with a theme-aware swap.
//
// Renders BOTH variants — /logo.png (production) and /logo-dark.png (the
// uploaded white logo used by the premium dark preview). A pair of CSS rules
// in globals.css picks which one is visible: by default `.logo-dark` is
// `display: none`, and under `.theme-premium-dark` (test accounts only) the
// roles flip. That keeps the swap purely visual — no client-side detection,
// no hydration flash, and non-test users never even see the dark image
// because their html element never has the theme class.

type LogoProps = {
  width: number;
  height: number;
  className?: string;
  priority?: boolean;
};

const ALT = "Elevate Homescriptions";

export function Logo({ width, height, className, priority }: LogoProps) {
  const base = className ?? "";
  return (
    <>
      <Image
        src="/logo.png"
        alt={ALT}
        width={width}
        height={height}
        priority={priority}
        className={`logo-light ${base}`.trim()}
      />
      {/* The dark logo has a wider aspect ratio than the light one. We honor
          the caller's width and let height auto-scale (`h-auto`) so the image
          is never stretched/squashed to match the light logo's box. */}
      <Image
        src="/logo-dark.png"
        alt={ALT}
        width={width}
        height={height}
        priority={priority}
        className={`logo-dark h-auto ${base}`.trim()}
      />
    </>
  );
}
