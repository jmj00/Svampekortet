// Tiny DOM helpers shared by the forest finder and the About
// dialogs: an element factory and the handful of inline SVG icons they use
// (inline so nothing is fetched from a third-party origin).

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 24x24, stroke icons drawn with currentColor.
const ICON_PATHS = {
  pin: '<path d="M12 21s-6.5-6.1-6.5-11a6.5 6.5 0 0 1 13 0c0 4.900-6.500 11-6.500 11z"/><circle cx="12" cy="10" r="2.300"/>',
  gauge:
    '<path d="M4.500 17a8.500 8.500 0 1 1 15 0"/><path d="M12 14.500l3.600-5"/><circle cx="12" cy="15" r="1.200"/>',
  mushroom:
    '<path d="M2.800 11.600C2.800 7 6.900 3.500 12 3.500s9.200 3.500 9.200 8.100c0 .9-.7 1.500-1.600 1.500H4.400c-.9 0-1.600-.6-1.600-1.500z"/><path d="M9.700 13.100c.2 2-.1 3.900-.8 5.700-.3.900.3 1.700 1.200 1.700h3.800c.9 0 1.500-.8 1.200-1.700-.7-1.800-1-3.700-.8-5.700"/><circle cx="8.300" cy="8.700" r="0.900" fill="currentColor" stroke="none"/><circle cx="13.400" cy="7.200" r="1.100" fill="currentColor" stroke="none"/>',
  tree: '<path d="M12 2.800l4.300 5.700h-2.100l4.300 5.500h-2.300l3.300 4H4.500l3.300-4H5.500l4.300-5.500H7.700z"/><path d="M12 18v3.200"/>',
  phone:
    '<path d="M6.200 3.500h3l1.400 4.200-2 1.500a12 12 0 0 0 6.200 6.200l1.500-2 4.200 1.400v3a2 2 0 0 1-2.200 2A16.500 16.500 0 0 1 4.200 5.700a2 2 0 0 1 2-2.200z"/>',
  warning:
    '<path d="M12 3.500l9.500 16.500h-19z"/><path d="M12 10v4.500"/><circle cx="12" cy="17.200" r="0.600" fill="currentColor"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevron: '<path d="M9.500 5.500l6.500 6.500-6.500 6.500"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.300 9.500a2.800 2.800 0 1 1 4.200 2.400c-.900.600-1.500 1.100-1.500 2.300"/><circle cx="12" cy="17.300" r="0.600" fill="currentColor"/>',
  locate:
    '<circle cx="12" cy="12" r="6.500"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M12 2.500v3M12 18.500v3M2.500 12h3M18.500 12h3"/>',
  calendar:
    '<rect x="3.500" y="5" width="17" height="15.500" rx="2"/><path d="M3.500 10h17M8 3v4M16 3v4"/>',
  rain: '<path d="M7 16a4.500 4.500 0 1 1 1.200-8.800A5.500 5.500 0 0 1 18.700 9a3.500 3.500 0 0 1-.7 7"/><path d="M9 18.500l-1 2.500M13 18.500l-1 2.500M17 18.500l-1 2.500"/>',
  shield:
    '<path d="M12 3l7.500 3v5.500c0 4.500-3.100 8.200-7.500 9.500-4.400-1.300-7.500-5-7.500-9.500V6z"/>',
  book: '<path d="M4.500 5.500A2.500 2.500 0 0 1 7 3h12.500v15H7a2.500 2.500 0 0 0-2.500 2.500z"/><path d="M4.500 20.500A2.500 2.500 0 0 0 7 21h12.500"/>',
  map: '<path d="M3.500 6.500l5.500-2 6 2 5.500-2v13l-5.500 2-6-2-5.500 2z"/><path d="M9 4.500v13M15 6.500v13"/>',
  share:
    '<path d="M12 3.500v11"/><path d="M8 7.300l4-3.800 4 3.800"/><path d="M8.500 10.500H6.500v10h11v-10h-2"/>',
  addSquare:
    '<rect x="4" y="4" width="16" height="16" rx="3.500"/><path d="M12 8.500v7M8.500 12h7"/>',
  check: '<path d="M5 12.500l4.500 4.500L19 7.500"/>',
  menu: '<circle cx="12" cy="5.500" r="1.300" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.300" fill="currentColor" stroke="none"/><circle cx="12" cy="18.500" r="1.300" fill="currentColor" stroke="none"/>',
  install:
    '<rect x="6.500" y="2.500" width="11" height="19" rx="2.500"/><path d="M12 7v7M9 11l3 3 3-3"/><path d="M10.500 18.500h3"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** A decorative inline icon (aria-hidden); label the control around it. */
export function icon(name: IconName, className = "sk-icon"): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", className);
  svg.innerHTML = ICON_PATHS[name];
  return svg;
}
