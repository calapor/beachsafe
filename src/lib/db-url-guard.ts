export function isNeonUrl(url: string): boolean {
  try {
    return /neon\.tech/i.test(new URL(url).host);
  } catch {
    return /neon\.tech/i.test(url);
  }
}
