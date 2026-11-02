// Minimal line icons (stroke = currentColor) for the sidebar.
const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };

export const PayIcon = () => (
  <svg {...base}>
    <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
    <path d="M2.5 10h19M6.5 15h3" />
  </svg>
);

export const AnalyticsIcon = () => (
  <svg {...base}>
    <path d="M3 12h4l3-7 4 14 3-7h4" />
  </svg>
);

export const ListIcon = () => (
  <svg {...base}>
    <path d="M9 6h12M9 12h12M9 18h12" />
    <circle cx="4.5" cy="6" r="1" />
    <circle cx="4.5" cy="12" r="1" />
    <circle cx="4.5" cy="18" r="1" />
  </svg>
);

export const BenchIcon = () => (
  <svg {...base}>
    <path d="M3 3v18h18" />
    <path d="M8 17v-5M13 17V7M18 17v-8" />
  </svg>
);
