export function isInstagramUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return (
      h === 'instagram.com' ||
      h === 'www.instagram.com' ||
      h === 'm.instagram.com' ||
      h === 'instagr.am'
    );
  } catch {
    return false;
  }
}

