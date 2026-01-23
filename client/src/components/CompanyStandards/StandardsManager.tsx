import React, { useEffect, useState } from 'react';
import { CompanyStandard } from '../../types';
import api from '../../services/api';
import { Button, Input, TextArea, Select, Card, CardBody, CardHeader, Modal, TranslatedText } from '../common';
import { useLanguage } from '../../context/LanguageContext';

type StandardType = 'voice' | 'platform' | 'image';

interface StandardFormData {
  name: string;
  standard_type: StandardType;
  tone?: string;
  style?: string;
  guidelines: string[];
  platform?: string;
  requirements?: string[];
  characterLimits?: Record<string, number>;
  dimensions?: string;
}

const EMPTY_FORM: StandardFormData = {
  name: '',
  standard_type: 'voice',
  tone: '',
  style: '',
  guidelines: [''],
  platform: '',
  requirements: [''],
  dimensions: '',
};

export function StandardsManager() {
  const { t } = useLanguage();
  const [standards, setStandards] = useState<CompanyStandard[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [editingStandard, setEditingStandard] = useState<CompanyStandard | null>(null);
  const [formData, setFormData] = useState<StandardFormData>(EMPTY_FORM);
  const [activeTab, setActiveTab] = useState<StandardType>('voice');

  useEffect(() => {
    loadStandards();
  }, []);

  const loadStandards = async () => {
    setIsLoading(true);
    try {
      const data = await api.getStandards();
      setStandards(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCreate = () => {
    setEditingStandard(null);
    setFormData({ ...EMPTY_FORM, standard_type: activeTab });
    setShowModal(true);
  };

  const handleEdit = (standard: CompanyStandard) => {
    setEditingStandard(standard);
    const content = standard.content;

    setFormData({
      name: standard.name,
      standard_type: standard.standard_type,
      tone: content.tone || '',
      style: content.style || '',
      guidelines: content.guidelines?.length ? content.guidelines : [''],
      platform: content.platform || '',
      requirements: content.requirements?.length ? content.requirements : [''],
      characterLimits: content.characterLimits || {},
      dimensions: content.dimensions || '',
    });
    setShowModal(true);
  };

  const handleDelete = async (standardId: number) => {
    if (!window.confirm('Are you sure you want to delete this standard?')) return;
    try {
      await api.deleteStandard(standardId);
      setStandards(standards.filter((s) => s.id !== standardId));
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleSave = async () => {
    if (!formData.name) {
      setError('Name is required');
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      let content: any = {};

      switch (formData.standard_type) {
        case 'voice':
          content = {
            tone: formData.tone,
            style: formData.style,
            guidelines: formData.guidelines.filter((g) => g.trim()),
          };
          break;
        case 'platform':
          content = {
            platform: formData.platform,
            requirements: formData.requirements?.filter((r) => r.trim()),
            characterLimits: formData.characterLimits,
          };
          break;
        case 'image':
          content = {
            style: formData.style,
            dimensions: formData.dimensions,
            guidelines: formData.guidelines.filter((g) => g.trim()),
          };
          break;
      }

      if (editingStandard) {
        await api.updateStandard(editingStandard.id, {
          name: formData.name,
          content,
        });
      } else {
        await api.createStandard({
          name: formData.name,
          standard_type: formData.standard_type,
          content,
        });
      }

      await loadStandards();
      setShowModal(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSaving(false);
    }
  };

  const addGuideline = () => {
    setFormData({
      ...formData,
      guidelines: [...(formData.guidelines || []), ''],
    });
  };

  const updateGuideline = (index: number, value: string) => {
    const guidelines = [...(formData.guidelines || [])];
    guidelines[index] = value;
    setFormData({ ...formData, guidelines });
  };

  const removeGuideline = (index: number) => {
    const guidelines = (formData.guidelines || []).filter((_, i) => i !== index);
    setFormData({ ...formData, guidelines: guidelines.length ? guidelines : [''] });
  };

  const addRequirement = () => {
    setFormData({
      ...formData,
      requirements: [...(formData.requirements || []), ''],
    });
  };

  const updateRequirement = (index: number, value: string) => {
    const requirements = [...(formData.requirements || [])];
    requirements[index] = value;
    setFormData({ ...formData, requirements });
  };

  const removeRequirement = (index: number) => {
    const requirements = (formData.requirements || []).filter((_, i) => i !== index);
    setFormData({ ...formData, requirements: requirements.length ? requirements : [''] });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  const filteredStandards = standards.filter((s) => s.standard_type === activeTab);

  const tabs = [
    { id: 'voice' as StandardType, labelKey: 'voiceStandard' as const, icon: VoiceIcon },
    { id: 'platform' as StandardType, labelKey: 'platformStandard' as const, icon: PlatformIcon },
    { id: 'image' as StandardType, labelKey: 'imageStandard' as const, icon: ImageIcon },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-secondary-900">{t('companyStandardsTitle')}</h1>
          <p className="text-secondary-600 mt-1">
            {t('companyStandardsSubtitle')}
          </p>
        </div>
        <Button onClick={handleCreate}>{t('addStandard')}</Button>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-secondary-200">
        <nav className="flex space-x-8">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`
                flex items-center pb-4 px-1 border-b-2 font-medium text-sm transition-colors
                ${activeTab === tab.id
                  ? 'border-primary-500 text-primary-600'
                  : 'border-transparent text-secondary-500 hover:text-secondary-700 hover:border-secondary-300'
                }
              `}
            >
              <tab.icon className="w-5 h-5 mr-2" />
              {t(tab.labelKey)}
            </button>
          ))}
        </nav>
      </div>

      {/* Standards List */}
      {filteredStandards.length === 0 ? (
        <Card>
          <CardBody className="text-center py-12">
            <p className="text-secondary-600 mb-4">
              {t('noStandardsYet')}
            </p>
            <Button onClick={handleCreate}>{t('createStandard')}</Button>
          </CardBody>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {filteredStandards.map((standard) => (
            <StandardCard
              key={standard.id}
              standard={standard}
              onEdit={() => handleEdit(standard)}
              onDelete={() => handleDelete(standard.id)}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Create/Edit Modal */}
      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editingStandard ? t('editStandard') : t('createStandard')}
        size="lg"
      >
        <div className="space-y-4">
          <Input
            label={t('standardName')}
            value={formData.name}
            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
            placeholder={t('standardNamePlaceholder')}
          />

          {!editingStandard && (
            <Select
              label={t('standardType')}
              value={formData.standard_type}
              onChange={(e) =>
                setFormData({ ...formData, standard_type: e.target.value as StandardType })
              }
              options={tabs.map((tab) => ({ value: tab.id, label: t(tab.labelKey) }))}
            />
          )}

          {/* Voice Standard Fields */}
          {formData.standard_type === 'voice' && (
            <>
              <Input
                label={t('tone')}
                value={formData.tone || ''}
                onChange={(e) => setFormData({ ...formData, tone: e.target.value })}
                placeholder={t('tonePlaceholder')}
              />
              <Input
                label={t('style')}
                value={formData.style || ''}
                onChange={(e) => setFormData({ ...formData, style: e.target.value })}
                placeholder={t('stylePlaceholder')}
              />
              <div>
                <label className="block text-sm font-medium text-secondary-700 mb-2">
                  {t('guidelines')}
                </label>
                {formData.guidelines?.map((guideline, index) => (
                  <div key={index} className="flex items-center space-x-2 mb-2">
                    <Input
                      value={guideline}
                      onChange={(e) => updateGuideline(index, e.target.value)}
                      placeholder={t('guidelinePlaceholder')}
                    />
                    <button
                      onClick={() => removeGuideline(index)}
                      className="p-2 text-red-500 hover:text-red-700"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" onClick={addGuideline}>
                  + {t('addGuideline')}
                </Button>
              </div>
            </>
          )}

          {/* Platform Standard Fields */}
          {formData.standard_type === 'platform' && (
            <>
              <Input
                label={t('platform')}
                value={formData.platform || ''}
                onChange={(e) => setFormData({ ...formData, platform: e.target.value })}
                placeholder={t('platformPlaceholder')}
              />
              <div>
                <label className="block text-sm font-medium text-secondary-700 mb-2">
                  {t('requirements')}
                </label>
                {formData.requirements?.map((req, index) => (
                  <div key={index} className="flex items-center space-x-2 mb-2">
                    <Input
                      value={req}
                      onChange={(e) => updateRequirement(index, e.target.value)}
                      placeholder={t('requirementPlaceholder')}
                    />
                    <button
                      onClick={() => removeRequirement(index)}
                      className="p-2 text-red-500 hover:text-red-700"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" onClick={addRequirement}>
                  + {t('addRequirement')}
                </Button>
              </div>
            </>
          )}

          {/* Image Standard Fields */}
          {formData.standard_type === 'image' && (
            <>
              <Input
                label={t('style')}
                value={formData.style || ''}
                onChange={(e) => setFormData({ ...formData, style: e.target.value })}
                placeholder={t('stylePlaceholder')}
              />
              <Input
                label={t('dimensions')}
                value={formData.dimensions || ''}
                onChange={(e) => setFormData({ ...formData, dimensions: e.target.value })}
                placeholder={t('dimensionsPlaceholder')}
              />
              <div>
                <label className="block text-sm font-medium text-secondary-700 mb-2">
                  {t('guidelines')}
                </label>
                {formData.guidelines?.map((guideline, index) => (
                  <div key={index} className="flex items-center space-x-2 mb-2">
                    <Input
                      value={guideline}
                      onChange={(e) => updateGuideline(index, e.target.value)}
                      placeholder={t('guidelinePlaceholder')}
                    />
                    <button
                      onClick={() => removeGuideline(index)}
                      className="p-2 text-red-500 hover:text-red-700"
                    >
                      <TrashIcon className="w-4 h-4" />
                    </button>
                  </div>
                ))}
                <Button size="sm" variant="ghost" onClick={addGuideline}>
                  + {t('addGuideline')}
                </Button>
              </div>
            </>
          )}

          <div className="flex justify-end space-x-3 pt-4">
            <Button variant="ghost" onClick={() => setShowModal(false)}>
              {t('cancel')}
            </Button>
            <Button onClick={handleSave} isLoading={isSaving}>
              {editingStandard ? t('saveChanges') : t('createStandard')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

interface StandardCardProps {
  standard: CompanyStandard;
  onEdit: () => void;
  onDelete: () => void;
  t: (key: any) => string;
}

function StandardCard({ standard, onEdit, onDelete, t }: StandardCardProps) {
  const content = standard.content;

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <h3 className="font-semibold text-secondary-900">
          <TranslatedText text={standard.name} />
        </h3>
        <div className="flex items-center space-x-2">
          <Button size="sm" variant="ghost" onClick={onEdit}>
            {t('edit')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            {t('delete')}
          </Button>
        </div>
      </CardHeader>
      <CardBody className="space-y-2 text-sm">
        {content.tone && (
          <p>
            <span className="font-medium">{t('tone')}:</span> <TranslatedText text={content.tone} />
          </p>
        )}
        {content.style && (
          <p>
            <span className="font-medium">{t('style')}:</span> <TranslatedText text={content.style} />
          </p>
        )}
        {content.platform && (
          <p>
            <span className="font-medium">{t('platform')}:</span> <TranslatedText text={content.platform} />
          </p>
        )}
        {content.dimensions && (
          <p>
            <span className="font-medium">{t('dimensions')}:</span> <TranslatedText text={content.dimensions} />
          </p>
        )}
        {content.guidelines?.length > 0 && (
          <div>
            <span className="font-medium">{t('guidelines')}:</span>
            <ul className="list-disc list-inside ml-2 text-secondary-600">
              {content.guidelines.slice(0, 3).map((g: string, i: number) => (
                <li key={i}><TranslatedText text={g} /></li>
              ))}
              {content.guidelines.length > 3 && (
                <li className="text-secondary-400">
                  +{content.guidelines.length - 3} {t('more')}...
                </li>
              )}
            </ul>
          </div>
        )}
        {content.requirements?.length > 0 && (
          <div>
            <span className="font-medium">{t('requirements')}:</span>
            <ul className="list-disc list-inside ml-2 text-secondary-600">
              {content.requirements.slice(0, 3).map((r: string, i: number) => (
                <li key={i}><TranslatedText text={r} /></li>
              ))}
              {content.requirements.length > 3 && (
                <li className="text-secondary-400">
                  +{content.requirements.length - 3} {t('more')}...
                </li>
              )}
            </ul>
          </div>
        )}
      </CardBody>
    </Card>
  );
}

// Icons
function VoiceIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
    </svg>
  );
}

function PlatformIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  );
}

function ImageIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}

function TrashIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}
