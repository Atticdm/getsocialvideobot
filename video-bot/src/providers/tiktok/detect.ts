export function isTikTokUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return (
      h === 'tiktok.com' ||
      h === 'www.tiktok.com' ||
      h === 'm.tiktok.com' ||
      h === 'vm.tiktok.com' ||
      h === 'vt.tiktok.com'
    );
  } catch {
    return false;
  }
}

