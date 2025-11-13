export function isVkUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return (
      h === 'vk.com' ||
      h === 'www.vk.com' ||
      h === 'm.vk.com' ||
      h === 'vk.ru' ||
      h === 'www.vk.ru' ||
      h === 'm.vk.ru' ||
      (h.includes('vk.com') && (u.pathname.includes('/video') || u.pathname.includes('/clip')))
    );
  } catch {
    return false;
  }
}

