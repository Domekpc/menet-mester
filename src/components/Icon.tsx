// Small hand-picked stroke icon set (Lucide-style paths).
const paths: Record<string, string> = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 15V9a4 4 0 0 1 4-4h4M18 9v6a4 4 0 0 1-4 4h-4',
  pin: 'M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  building: 'M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h4M8 11h4M8 15h4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.2L3 17.8V21h3.2l6.3-6.3a4 4 0 0 0 5.2-5.4l-2.6 2.6-2.5-.7-.7-2.5z',
  sparkles: 'M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  plus: 'M12 5v14M5 12h14',
  edit: 'M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3',
  x: 'M6 6l12 12M18 6 6 18',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  arrowLeft: 'M19 12H5M11 18l-6-6 6-6',
  download: 'M12 4v12M6 10l6 6 6-6M4 20h16',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  save: 'M5 3h11l3 3v15H5zM8 3v5h7M8 21v-7h8v7',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-5M12 8h.01',
  alert: 'M12 3 2 20h20zM12 10v4M12 17h.01',
  gauge: 'M12 14l4-4M3.3 17a10 10 0 1 1 17.4 0M7 17h10',
  calendar: 'M4 6h16v15H4zM4 10h16M8 3v4M16 3v4',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  file: 'M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6',
  check: 'M5 12l5 5 9-10',
  swap: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
};

/**
 * The Menet Mester car (assets/menetmester_auto_ikon.svg). It is drawn on a wider canvas, so the
 * stroke is kept at the same on-screen weight as the other icons; the colour comes from the context.
 */
function CarIcon({ size }: { size?: number }) {
  const line = { vectorEffect: 'non-scaling-stroke' as const };
  return (
    <svg viewBox="4 4 120 62" fill="none" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
      style={size ? { width: size, height: size } : undefined} aria-hidden="true">
      <g style={line}>
        <path style={line} d="M21 53H13c-4.4 0-7-2.8-7-7v-5c0-4.6 2.7-7.6 7-8.8l12-3.2 11-13.2c3.1-3.8 6.7-5.6 11.8-5.6h31.3c5.9 0 10.3 2.3 13.8 7.3L103 30l11 2.8c5.4 1.4 8 4.5 8 9.2v4c0 4.3-2.8 7-7 7h-9" />
        <path style={line} d="M85 53H42" />
        <circle style={line} cx="31.5" cy="53" r="10.5" />
        <circle style={line} cx="95.5" cy="53" r="10.5" />
        <circle style={line} cx="31.5" cy="53" r="3.2" />
        <circle style={line} cx="95.5" cy="53" r="3.2" />
        <path style={line} d="M33 29h30V16H49.2c-3.4 0-5.6 1-7.7 3.4L33 29Z" />
        <path style={line} d="M69 16v13h26.2l-8.1-10.1c-1.7-2.1-4-2.9-7-2.9H69Z" />
        <path style={line} d="M67 35v10M51 36h7M77 36h7M8 40h9M112 40h9" />
      </g>
    </svg>
  );
}

export function Icon({ name, size }: { name: keyof typeof paths | string; size?: number }) {
  if (name === 'car') return <CarIcon size={size} />;
  return (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
      style={size ? { width: size, height: size } : undefined} aria-hidden="true">
      <path d={paths[name] ?? paths.info} />
    </svg>
  );
}
