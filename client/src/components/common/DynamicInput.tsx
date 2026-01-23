import React, { useRef, useState, useEffect } from 'react';
import { InputTypeConfig } from '../../types';
import { Input, TextArea, Button } from './index';
import { useLanguage } from '../../context/LanguageContext';
import { translateText } from '../../services/translationService';

interface DynamicInputProps {
  name: string;
  config: InputTypeConfig;
  value: any;
  onChange: (value: any) => void;
  t: (key: any) => string;
}

export function DynamicInput({ name, config, value, onChange, t }: DynamicInputProps) {
  const { language } = useLanguage();
  const [translatedLabel, setTranslatedLabel] = useState(config.label || name);
  const [translatedPlaceholder, setTranslatedPlaceholder] = useState(config.placeholder || '');
  const [translatedDescription, setTranslatedDescription] = useState(config.description);

  // Translate label, placeholder, and description when language changes
  useEffect(() => {
    const sourceLabel = config.label || name;
    const sourcePlaceholder = config.placeholder || '';
    const sourceDescription = config.description;

    if (language === 'en') {
      // No translation needed for English (assuming source is English)
      setTranslatedLabel(sourceLabel);
      setTranslatedPlaceholder(sourcePlaceholder);
      setTranslatedDescription(sourceDescription);
    } else {
      // Translate to target language
      translateText(sourceLabel, 'en', language).then(setTranslatedLabel);
      if (sourcePlaceholder) {
        translateText(sourcePlaceholder, 'en', language).then(setTranslatedPlaceholder);
      }
      if (sourceDescription) {
        translateText(sourceDescription, 'en', language).then(setTranslatedDescription);
      }
    }
  }, [config.label, config.placeholder, config.description, name, language]);

  const label = translatedLabel;
  const placeholder = translatedPlaceholder;
  const description = translatedDescription;

  switch (config.type) {
    case 'text':
      return (
        <div>
          <Input
            label={label}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
          />
          {description && (
            <p className="mt-1 text-xs text-secondary-500">{description}</p>
          )}
        </div>
      );

    case 'textarea':
      return (
        <div>
          <TextArea
            label={label}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            rows={4}
          />
          {description && (
            <p className="mt-1 text-xs text-secondary-500">{description}</p>
          )}
        </div>
      );

    case 'image':
      return (
        <ImageInput
          label={label}
          value={value}
          onChange={onChange}
          description={description}
          maxSize={config.maxImageSize || 10}
          t={t}
        />
      );

    case 'url_list':
      return (
        <UrlListInput
          label={label}
          value={value || []}
          onChange={onChange}
          description={description}
          minUrls={config.minUrls || 1}
          maxUrls={config.maxUrls || 10}
          placeholder={placeholder}
          t={t}
        />
      );

    case 'file':
      return (
        <FileInput
          label={label}
          value={value}
          onChange={onChange}
          description={description}
          acceptedTypes={config.acceptedFileTypes || []}
          t={t}
        />
      );

    default:
      return (
        <Input
          label={label}
          value={value || ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
      );
  }
}

// Image Upload Component
interface ImageInputProps {
  label: string;
  value: any;
  onChange: (value: any) => void;
  description?: string;
  maxSize: number;
  t: (key: any) => string;
}

function ImageInput({ label, value, onChange, description, maxSize, t }: ImageInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(value?.preview || null);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Check file size
    if (file.size > maxSize * 1024 * 1024) {
      setError(`${t('fileTooLarge')} ${maxSize}MB`);
      return;
    }

    // Check file type
    if (!file.type.startsWith('image/')) {
      setError(t('invalidImageType'));
      return;
    }

    setError(null);

    // Create preview
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result as string;
      setPreview(base64);
      onChange({ file, base64, name: file.name, type: file.type });
    };
    reader.readAsDataURL(file);
  };

  const handleRemove = () => {
    setPreview(null);
    onChange(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium text-secondary-700 mb-2">
        {label}
      </label>
      {preview ? (
        <div className="relative inline-block">
          <img
            src={preview}
            alt="Preview"
            className="max-w-xs max-h-48 rounded-lg border border-secondary-200"
          />
          <button
            onClick={handleRemove}
            className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600"
          >
            ×
          </button>
        </div>
      ) : (
        <div
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-secondary-300 rounded-lg p-8 text-center cursor-pointer hover:border-primary-400 transition-colors"
        >
          <div className="text-4xl mb-2">🖼️</div>
          <p className="text-secondary-600">{t('clickToUploadImage')}</p>
          <p className="text-xs text-secondary-400 mt-1">
            {t('maxSize')}: {maxSize}MB
          </p>
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
      />
      {error && (
        <p className="mt-1 text-sm text-red-600">{error}</p>
      )}
      {description && (
        <p className="mt-1 text-xs text-secondary-500">{description}</p>
      )}
    </div>
  );
}

// URL List Component
interface UrlListInputProps {
  label: string;
  value: string[];
  onChange: (value: string[]) => void;
  description?: string;
  minUrls: number;
  maxUrls: number;
  placeholder?: string;
  t: (key: any) => string;
}

function UrlListInput({ label, value, onChange, description, minUrls, maxUrls, placeholder, t }: UrlListInputProps) {
  const urls = value.length > 0 ? value : [''];

  const handleUrlChange = (index: number, newValue: string) => {
    const newUrls = [...urls];
    newUrls[index] = newValue;
    onChange(newUrls.filter(u => u.trim() !== ''));
  };

  const addUrl = () => {
    if (urls.length < maxUrls) {
      onChange([...urls, '']);
    }
  };

  const removeUrl = (index: number) => {
    if (urls.length > minUrls) {
      const newUrls = urls.filter((_, i) => i !== index);
      onChange(newUrls.length > 0 ? newUrls : ['']);
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium text-secondary-700 mb-2">
        {label}
      </label>
      <div className="space-y-2">
        {urls.map((url, index) => (
          <div key={index} className="flex gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => handleUrlChange(index, e.target.value)}
              placeholder={placeholder || 'https://...'}
              className="flex-1 px-3 py-2 border border-secondary-300 rounded-lg focus:ring-2 focus:ring-primary-500 focus:border-transparent"
            />
            {urls.length > minUrls && (
              <button
                onClick={() => removeUrl(index)}
                className="px-3 py-2 text-red-500 hover:bg-red-50 rounded-lg"
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
      {urls.length < maxUrls && (
        <button
          onClick={addUrl}
          className="mt-2 text-sm text-primary-600 hover:text-primary-700"
        >
          + {t('addUrl')}
        </button>
      )}
      <p className="mt-1 text-xs text-secondary-400">
        {minUrls === maxUrls
          ? `${t('exactlyNUrls').replace('{n}', String(minUrls))}`
          : `${minUrls} - ${maxUrls} URLs`}
      </p>
      {description && (
        <p className="mt-1 text-xs text-secondary-500">{description}</p>
      )}
    </div>
  );
}

// File Upload Component
interface FileInputProps {
  label: string;
  value: any;
  onChange: (value: any) => void;
  description?: string;
  acceptedTypes: string[];
  t: (key: any) => string;
}

function FileInput({ label, value, onChange, description, acceptedTypes, t }: FileInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(value?.name || null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const acceptString = acceptedTypes.length > 0 ? acceptedTypes.join(',') : '*';

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Check file type if restrictions exist
    if (acceptedTypes.length > 0) {
      const ext = '.' + file.name.split('.').pop()?.toLowerCase();
      if (!acceptedTypes.some(t => t.toLowerCase() === ext)) {
        setError(`${t('invalidFileType')} ${acceptedTypes.join(', ')}`);
        return;
      }
    }

    setError(null);
    setFileName(file.name);

    // Read file content
    const reader = new FileReader();
    reader.onloadend = () => {
      const content = reader.result as string;
      setFileContent(content);
      onChange({ file, content, name: file.name, type: file.type });
    };

    // For text-based files, read as text
    if (file.type.includes('text') || file.name.endsWith('.csv') || file.name.endsWith('.json')) {
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file);
    }
  };

  const handleRemove = () => {
    setFileName(null);
    setFileContent(null);
    onChange(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium text-secondary-700 mb-2">
        {label}
      </label>
      {fileName ? (
        <div className="flex items-center gap-3 p-3 bg-secondary-50 rounded-lg">
          <span className="text-2xl">📄</span>
          <div className="flex-1">
            <p className="font-medium text-secondary-900">{fileName}</p>
            {fileContent && (
              <p className="text-xs text-secondary-500">
                {t('fileLoaded')}
              </p>
            )}
          </div>
          <button
            onClick={handleRemove}
            className="px-3 py-1 text-red-500 hover:bg-red-100 rounded"
          >
            {t('remove')}
          </button>
        </div>
      ) : (
        <div
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed border-secondary-300 rounded-lg p-6 text-center cursor-pointer hover:border-primary-400 transition-colors"
        >
          <div className="text-3xl mb-2">📁</div>
          <p className="text-secondary-600">{t('clickToUploadFile')}</p>
          {acceptedTypes.length > 0 && (
            <p className="text-xs text-secondary-400 mt-1">
              {t('acceptedTypes')}: {acceptedTypes.join(', ')}
            </p>
          )}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept={acceptString}
        onChange={handleFileChange}
        className="hidden"
      />
      {error && (
        <p className="mt-1 text-sm text-red-600">{error}</p>
      )}
      {description && (
        <p className="mt-1 text-xs text-secondary-500">{description}</p>
      )}
    </div>
  );
}
