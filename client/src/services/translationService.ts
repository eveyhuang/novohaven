import { Language } from '../i18n/translations';

// Cache for translations to avoid repeated API calls
const translationCache = new Map<string, string>();

// Generate cache key
function getCacheKey(text: string, from: Language, to: Language): string {
  return `${from}:${to}:${text}`;
}

// Translate text using MyMemory free translation API
export async function translateText(
  text: string,
  from: Language,
  to: Language
): Promise<string> {
  // If same language or empty text, return as-is
  if (from === to || !text || !text.trim()) {
    return text;
  }

  // Check cache first
  const cacheKey = getCacheKey(text, from, to);
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey)!;
  }

  try {
    // Map language codes for the API
    const langMap: Record<Language, string> = {
      en: 'en',
      zh: 'zh-CN',
    };

    const response = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${langMap[from]}|${langMap[to]}`
    );

    if (!response.ok) {
      console.warn('Translation API error, returning original text');
      return text;
    }

    const data = await response.json();

    if (data.responseStatus === 200 && data.responseData?.translatedText) {
      const translated = data.responseData.translatedText;
      // Cache the result
      translationCache.set(cacheKey, translated);
      return translated;
    }

    return text;
  } catch (error) {
    console.warn('Translation failed, returning original text:', error);
    return text;
  }
}

// Batch translate multiple texts
export async function translateTexts(
  texts: string[],
  from: Language,
  to: Language
): Promise<string[]> {
  // If same language, return as-is
  if (from === to) {
    return texts;
  }

  // Translate all texts in parallel
  const promises = texts.map((text) => translateText(text, from, to));
  return Promise.all(promises);
}

// Clear translation cache (useful when needed)
export function clearTranslationCache(): void {
  translationCache.clear();
}
