import React from 'react';

export interface IconProps { size?: number; className?: string; title?: string }
/** 24-grid stroke icons: 2.25 stroke, round caps/joins, currentColor. */
function Svg({ size = 24, className, title, children }: IconProps & { children: React.ReactNode }) {
 return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25} strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>{title ? <title>{title}</title> : null}{children}</svg>;
}
export const IconHome = (p: IconProps) => <Svg {...p}><path d="M4 11.5 12 4l8 7.5" /><path d="M6 10v9h12v-9" /><path d="M10 19v-5h4v5" /></Svg>;
export const IconLibrary = (p: IconProps) => <Svg {...p}><rect x="4" y="4" width="7" height="7" /><rect x="13" y="4" width="7" height="7" /><rect x="4" y="13" width="7" height="7" /><rect x="13" y="13" width="7" height="7" /></Svg>;
export const IconDigested = (p: IconProps) => <Svg {...p}><path d="m5 13 4.5 4.5L19 8" /></Svg>;
export const IconSettings = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="3.2" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8" /></Svg>;
export const IconSync = (p: IconProps) => <Svg {...p}><path d="M20 12a8 8 0 1 1-2.5-5.8" /><path d="M20 4v5h-5" /></Svg>;
export const IconTheme = (p: IconProps) => <Svg {...p}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 7 7 0 1 0 20 14.5Z" /></Svg>;
export const IconBack = (p: IconProps) => <Svg {...p}><path d="M14 6l-6 6 6 6" /><path d="M9 12h11" /></Svg>;
export const IconMore = (p: IconProps) => <Svg {...p}><circle cx="5.5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18.5" cy="12" r="1.6" /></Svg>;
export const IconExport = (p: IconProps) => <Svg {...p}><path d="M12 4v11" /><path d="m7 10 5 5 5-5" /><path d="M4 19h16" /></Svg>;
export const IconClose = (p: IconProps) => <Svg {...p}><path d="m6 6 12 12M18 6 6 18" /></Svg>;
export const IconSearch = (p: IconProps) => <Svg {...p}><circle cx="10.5" cy="10.5" r="6" /><path d="m15.5 15.5 5 5" /></Svg>;
export const IconCheck = (p: IconProps) => <Svg {...p}><path d="m5 13 4.5 4.5L19 8" /></Svg>;
export const IconPlay = (p: IconProps) => <Svg {...p}><path d="M8 5.5v13l11-6.5Z" /></Svg>;
export const IconImage = (p: IconProps) => <Svg {...p}><rect x="4" y="5" width="16" height="14" /><circle cx="9" cy="10" r="1.8" /><path d="m5 17 5-5 4 4 3-3 3 3" /></Svg>;
export const IconVideo = (p: IconProps) => <Svg {...p}><rect x="3.5" y="6" width="12" height="12" /><path d="m15.5 10.5 5-3v9l-5-3" /></Svg>;
export const IconText = (p: IconProps) => <Svg {...p}><path d="M6 5h12M12 5v14M9 19h6" /></Svg>;
export const IconWarning = (p: IconProps) => <Svg {...p}><path d="M12 4 3 19.5h18Z" /><path d="M12 10v4.5" /><circle cx="12" cy="16.8" r=".4" /></Svg>;
export const IconRetry = (p: IconProps) => <Svg {...p}><path d="M4 12a8 8 0 1 0 2.5-5.8" /><path d="M4 4v5h5" /></Svg>;
export const IconZoomIn = (p: IconProps) => <Svg {...p}><circle cx="10.5" cy="10.5" r="6" /><path d="M10.5 8v5M8 10.5h5" /><path d="m15.5 15.5 5 5" /></Svg>;
export const IconZoomOut = (p: IconProps) => <Svg {...p}><circle cx="10.5" cy="10.5" r="6" /><path d="M8 10.5h5" /><path d="m15.5 15.5 5 5" /></Svg>;
export const IconFitView = (p: IconProps) => <Svg {...p}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Svg>;
export const IconSplit = (p: IconProps) => <Svg {...p}><rect x="4" y="4" width="16" height="16" /><path d="M12 4v16" /></Svg>;
export const IconMap = (p: IconProps) => <Svg {...p}><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="6" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8.3 10.8 15.7 7M8.3 13.2l7.4 3.8" /></Svg>;
export const IconDocument = (p: IconProps) => <Svg {...p}><path d="M7 3h8l4 4v14H7Z" /><path d="M15 3v4h4" /><path d="M10 12h6M10 16h6" /></Svg>;
export const IconExternal = (p: IconProps) => <Svg {...p}><path d="M10 5H5v14h14v-5" /><path d="M14 4h6v6" /><path d="m20 4-9 9" /></Svg>;
export const IconSparkle = (p: IconProps) => <Svg {...p}><path d="M12 4l1.9 5.6L19.5 12l-5.6 1.9L12 19.5l-1.9-5.6L4.5 12l5.6-2.4Z" /></Svg>;
export const IconArrowDownLeft = (p: IconProps) => <Svg {...p}><path d="M17 7 7 17" /><path d="M15 17H7V9" /></Svg>;
export const IconQueue = (p: IconProps) => <Svg {...p}><path d="M4 6h16M4 12h16M4 18h10" /></Svg>;
export const IconQuestion = (p: IconProps) => <Svg {...p}><path d="M9 9a3 3 0 0 1 5.8 1c0 2-2.8 2.6-2.8 4" /><circle cx="12" cy="18" r=".4" /></Svg>;
export const IconTarget = (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="7" /><circle cx="12" cy="12" r="2" /></Svg>;
export const IconAudio = (p: IconProps) => <Svg {...p}><path d="M12 4v16" /><path d="M8 8v8" /><path d="M16 8v8" /><path d="M4 10v4" /><path d="M20 10v4" /></Svg>;
export const IconCard = (p: IconProps) => <Svg {...p}><rect x="4" y="3.5" width="16" height="17" /><path d="M8 8.5h8M8 12.5h5M8 16.5h7" /></Svg>;
