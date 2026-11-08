export function HolidayStar({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 0c.8 7.5 4.5 11.2 12 12-7.5.8-11.2 4.5-12 12C11.2 16.5 7.5 12.8 0 12 7.5 11.2 11.2 7.5 12 0Z" />
    </svg>
  );
}

export function ChristmasTree() {
  return (
    <svg className="tree-illustration" viewBox="0 0 250 255" fill="none" aria-hidden="true">
      <g fill="#ffcf6c">
        <path d="M128 9c.9 8 4.8 11.9 13 13-8.2 1-12.1 5-13 13-1-8-4.9-12-13-13 8.1-1.1 12-5 13-13Z" />
        <path d="M211 88c.6 4.5 2.6 6.6 7 7-4.4.6-6.4 2.6-7 7-.5-4.4-2.5-6.4-7-7 4.5-.4 6.5-2.5 7-7ZM42 106c.5 3.9 2.1 5.5 6 6-3.9.5-5.5 2.1-6 6-.5-3.9-2.1-5.5-6-6 3.9-.5 5.5-2.1 6-6Z" opacity=".8" />
        <circle cx="178" cy="43" r="1.6" /><circle cx="73" cy="55" r="1.6" /><circle cx="228" cy="143" r="1.8" /><circle cx="27" cy="160" r="1.6" />
      </g>
      <ellipse cx="126" cy="231" rx="114" ry="12" fill="#0a2921" />
      <path d="M119 185h18v46h-18z" fill="#8e6242" />
      <path d="M128 39c-11 29-29 55-46 67l15-2c-12 22-34 46-52 56l21-3c-16 24-38 40-55 50 29 4 53 4 73-4 13 6 32 8 44 4 15 4 32 3 49-4 19 7 40 7 61 4-18-10-37-26-54-50l21 3c-19-11-40-34-52-56l16 2c-17-11-32-39-41-67Z" fill="#2b694f" />
      <path d="M128 39c-11 29-29 55-46 67l15-2c-12 22-34 46-52 56l21-3c-16 24-38 40-55 50 28 4 54 4 73-4 13 6 32 8 44 4V39Z" fill="#418166" />
      <path d="M98 100c13-2 33-9 46-17m-83 72c34-2 79-16 109-34m-134 76c51-1 109-17 158-46m-31 50c17-4 35-11 47-18" stroke="#e5cc8a" strokeWidth="1.4" strokeLinecap="round" opacity=".75" />
      <g fill="#ffcf6c">
        <circle cx="124" cy="70" r="3.6" /><circle cx="110" cy="123" r="4" /><circle cx="150" cy="147" r="3.6" /><circle cx="75" cy="178" r="4.3" /><circle cx="173" cy="189" r="4.3" />
      </g>
      <g fill="#f19786">
        <circle cx="140" cy="97" r="5" /><circle cx="90" cy="152" r="4.6" /><circle cx="179" cy="149" r="5" /><circle cx="120" cy="187" r="5" />
      </g>
      <g transform="rotate(-9 58 219)">
        <rect x="31" y="201" width="56" height="33" rx="3" fill="#b43a4a" />
        <path d="M54 201h9v33h-9zM31 211h56v6H31z" fill="#ffcf6c" />
        <path d="M59 201c-14 2-17-4-13-8s11 1 13 8Zm0 0c14 2 17-4 13-8s-11 1-13 8Z" stroke="#ffcf6c" strokeWidth="2.4" />
      </g>
      <g transform="rotate(10 197 222)">
        <rect x="177" y="211" width="45" height="28" rx="3" fill="#efbd68" />
        <path d="M196 211h7v28h-7zM177 219h45v5h-45z" fill="#8e2938" />
        <path d="M200 211c-10 1-13-4-9-6 3-2 7 1 9 6Zm0 0c10 1 13-4 9-6-3-2-7 1-9 6Z" stroke="#8e2938" strokeWidth="2.1" />
      </g>
    </svg>
  );
}

export function WrappedGift() {
  return (
    <svg className="gift-illustration" viewBox="0 0 132 108" fill="none" aria-hidden="true">
      <path d="M108 6c.8 5.4 3.5 8.1 9 9-5.5.7-8.2 3.4-9 9-.8-5.6-3.5-8.3-9-9 5.5-.9 8.2-3.6 9-9ZM17 26c.4 3.3 2.1 4.8 5 5-2.9.5-4.6 2.1-5 5-.4-2.9-2.1-4.5-5-5 2.9-.2 4.6-1.7 5-5Z" fill="#ffcf6c" />
      <circle cx="123" cy="53" r="1.7" fill="#f4b9a0" /><circle cx="19" cy="76" r="1.5" fill="#f4b9a0" />
      <g transform="rotate(10 67 65)">
        <rect x="31" y="41" width="77" height="48" rx="4" fill="#b43a4a" />
        <path d="M33 81h73v4a4 4 0 0 1-4 4H37a4 4 0 0 1-4-4v-4Z" fill="#952d3e" />
        <rect x="27" y="39" width="85" height="17" rx="3" fill="#c74956" />
        <path d="M64 39h11v50H64zM31 63h77v7H31z" fill="#ffcf6c" />
        <path d="M69.5 39c-19 1-25-6-19-12 5-5 14 1 19 12Zm0 0c19 1 25-6 19-12-5-5-14 1-19 12Z" stroke="#ffcf6c" strokeWidth="3.3" />
      </g>
    </svg>
  );
}
