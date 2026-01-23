import { useState, useEffect } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { translateText } from '../services/translationService';

// Hook to translate a single text
export function useTranslatedText(text: string | undefined, sourceLanguage: 'en' | 'zh' = 'en'): string {
  const { language } = useLanguage();
  const [translated, setTranslated] = useState(text || '');

  useEffect(() => {
    if (!text) {
      setTranslated('');
      return;
    }

    // If same language, no translation needed
    if (language === sourceLanguage) {
      setTranslated(text);
      return;
    }

    // Translate the text
    let cancelled = false;
    translateText(text, sourceLanguage, language).then((result) => {
      if (!cancelled) {
        setTranslated(result);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [text, language, sourceLanguage]);

  return translated;
}

// Hook to translate multiple texts at once
export function useTranslatedTexts(
  texts: (string | undefined)[],
  sourceLanguage: 'en' | 'zh' = 'en'
): string[] {
  const { language } = useLanguage();
  const [translated, setTranslated] = useState<string[]>(texts.map((t) => t || ''));

  useEffect(() => {
    // If same language, no translation needed
    if (language === sourceLanguage) {
      setTranslated(texts.map((t) => t || ''));
      return;
    }

    // Translate all texts
    let cancelled = false;
    Promise.all(
      texts.map((text) => (text ? translateText(text, sourceLanguage, language) : Promise.resolve('')))
    ).then((results) => {
      if (!cancelled) {
        setTranslated(results);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [texts.join('|'), language, sourceLanguage]);

  return translated;
}

// Hook to translate an object's string fields
export function useTranslatedObject<T extends Record<string, any>>(
  obj: T | null | undefined,
  fieldsToTranslate: (keyof T)[],
  sourceLanguage: 'en' | 'zh' = 'en'
): T | null | undefined {
  const { language } = useLanguage();
  const [translated, setTranslated] = useState<T | null | undefined>(obj);

  useEffect(() => {
    if (!obj) {
      setTranslated(obj);
      return;
    }

    // If same language, no translation needed
    if (language === sourceLanguage) {
      setTranslated(obj);
      return;
    }

    // Translate specified fields
    let cancelled = false;
    const translateFields = async () => {
      const result = { ...obj };
      await Promise.all(
        fieldsToTranslate.map(async (field) => {
          const value = obj[field];
          if (typeof value === 'string' && value) {
            (result as any)[field] = await translateText(value, sourceLanguage, language);
          }
        })
      );
      if (!cancelled) {
        setTranslated(result);
      }
    };

    translateFields();

    return () => {
      cancelled = true;
    };
  }, [obj, fieldsToTranslate.join(','), language, sourceLanguage]);

  return translated;
}
