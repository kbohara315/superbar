// Metric icons as SVG data URIs, drawn in each metric's colour.

import type { ImageAsset } from "nsh";
import type { MetricName, ProviderName } from "../types";
import logoCodex from "./assets/ProviderIcon-codex.svg";
import logoClaude from "./assets/ProviderIcon-claude.svg";

// The provider logos (white on the brand colour), as imported image assets.
export const PROVIDER_LOGO: Record<ProviderName, ImageAsset> = { codex: logoCodex, claude: logoClaude };

const BODY: Record<MetricName, string> = {
    cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>',
    memory: '<rect x="2" y="7" width="20" height="10" rx="1.5"/><path d="M6 17v3M10 17v3M14 17v3M18 17v3M6 11v2M10 11v2M14 11v2M18 11v2"/>',
    swap: '<path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7"/>',
    disk: '<rect x="3" y="14" width="18" height="6" rx="2"/><path d="M5 14l2.5-9h9L19 14"/><path d="M16.5 17h.01"/>',
    network: '<path d="M8 20V5M4 9l4-4 4 4M16 4v15M12 15l4 4 4-4"/>',
    battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2M6 10v4M10 10v4"/>',
    temperature: '<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/>',
};

export function metricIconUri(name: MetricName, color: string): string {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" '
        + `stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${BODY[name]}</svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
