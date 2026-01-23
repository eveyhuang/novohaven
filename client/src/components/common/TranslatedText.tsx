import React, { useState, useEffect } from 'react';
import { useLanguage } from '../../context/LanguageContext';
import { translateText } from '../../services/translationService';

interface TranslatedTextProps {
  text: string;
  fallback?: string;
  as?: keyof JSX.IntrinsicElements;
  className?: string;
}

export function TranslatedText({
  text,
  fallback,
  as: Component = 'span',
  className
}: TranslatedTextProps) {
  const { language } = useLanguage();
  const [translated, setTranslated] = useState(text);

  useEffect(() => {
    if (!text) {
      setTranslated(fallback || '');
      return;
    }

    if (language === 'en') {
      setTranslated(text);
    } else {
      translateText(text, 'en', language).then(setTranslated);
    }
  }, [text, language, fallback]);

  return <Component className={className}>{translated || fallback}</Component>;
}
