import Image from "next/image";

// The brand logo — the white wordmark used by the global premium-dark theme.
// `h-auto` keeps the image at the caller's width while letting height
// auto-scale to the asset's natural aspect — never stretched or squashed.

type LogoProps = {
  width: number;
  height: number;
  className?: string;
  priority?: boolean;
};

const ALT = "Elevate Homescriptions";

export function Logo({ width, height, className, priority }: LogoProps) {
  return (
    <Image
      src="/logo-dark-1.png"
      alt={ALT}
      width={width}
      height={height}
      priority={priority}
      className={`h-auto ${className ?? ""}`.trim()}
    />
  );
}
