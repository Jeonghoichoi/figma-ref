export interface Preset {
  id: string;
  label: string;
  group: string;
  w: number;
  h: number;
}

/** Common artboard sizes (CSS px / pt), grouped like the frame presets in design tools. */
export const PRESETS: Preset[] = [
  { id: "desktop", label: "Desktop", group: "데스크톱", w: 1440, h: 1024 },
  { id: "macbook-air", label: "MacBook Air", group: "데스크톱", w: 1280, h: 832 },
  { id: "full-hd", label: "Full HD", group: "데스크톱", w: 1920, h: 1080 },
  { id: "iphone-16", label: "iPhone 16", group: "모바일", w: 393, h: 852 },
  { id: "iphone-16-pro-max", label: "iPhone 16 Pro Max", group: "모바일", w: 440, h: 956 },
  { id: "android", label: "Android Large", group: "모바일", w: 412, h: 917 },
  { id: "ipad", label: "iPad Pro 11\"", group: "태블릿", w: 834, h: 1194 },
  { id: "ig-post", label: "Instagram 게시물", group: "소셜", w: 1080, h: 1350 },
  { id: "ig-story", label: "Instagram 스토리", group: "소셜", w: 1080, h: 1920 },
  { id: "yt-thumb", label: "YouTube 썸네일", group: "소셜", w: 1280, h: 720 },
  { id: "a4", label: "A4", group: "인쇄", w: 595, h: 842 },
  { id: "slide", label: "프레젠테이션 16:9", group: "인쇄", w: 1920, h: 1080 },
];
