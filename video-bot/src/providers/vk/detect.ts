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
      h === 'vkvideo.ru' ||
      h === 'www.vkvideo.ru' ||
      (h.includes('vk.com') && (u.pathname.includes('/video') || u.pathname.includes('/clip'))) ||
      (h.includes('vkvideo.ru') && (u.pathname.includes('/clip') || u.pathname.includes('/video')))
    );
  } catch {
    return false;
  }
}

