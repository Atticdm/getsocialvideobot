export function isLinkedInUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    if (h.endsWith('linkedin.com') || h === 'lnkd.in') return true;
    return false;
  } catch {
    return false;
  }
}

