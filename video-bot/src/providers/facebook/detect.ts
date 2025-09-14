export function isFacebookUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname.toLowerCase();
    
    // Check for facebook.com and fb.watch domains
    return hostname === 'facebook.com' || 
           hostname === 'www.facebook.com' || 
           hostname === 'fb.watch' ||
           hostname === 'www.fb.watch' ||
           hostname === 'm.facebook.com';
  } catch {
    return false;
  }
}
