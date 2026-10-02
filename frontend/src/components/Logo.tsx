export default function Logo({ small }: { small?: boolean }) {
  return (
    <div className={`logo${small ? ' small' : ''}`}>
      <svg viewBox="0 0 32 32" width={small ? 26 : 34} height={small ? 26 : 34} aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="currentColor" />
        <circle cx="8.5" cy="16" r="2.6" fill="none" stroke="#fff" strokeWidth="2" />
        <path d="M11 16h4.5M15.5 16l5-5.5M15.5 16l5 5.5" stroke="#fff" strokeWidth="2" strokeLinecap="round" fill="none" />
        <rect x="21" y="7" width="6" height="6" rx="1.5" fill="#fff" />
        <rect x="21" y="19" width="6" height="6" rx="1.5" fill="#fff" />
      </svg>
      <span>FlowSmith <b>AI</b></span>
    </div>
  );
}
