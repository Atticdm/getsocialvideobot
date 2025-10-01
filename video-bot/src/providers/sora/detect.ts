export function isSoraUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return (
      h === 'sora.chatgpt.com' ||
      h === 'www.sora.chatgpt.com'
    );
  } catch {
    return false;
  }
}

