import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Recipe, WorkflowExecution } from '../../types';
import api from '../../services/api';
import { Button, Card, CardBody } from '../common';
import { useLanguage } from '../../context/LanguageContext';
import { translateText } from '../../services/translationService';

export function Dashboard() {
  const navigate = useNavigate();
  const { t } = useLanguage();
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [recentExecutions, setRecentExecutions] = useState<WorkflowExecution[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [recipesData, executionsData] = await Promise.all([
        api.getRecipes(),
        api.getExecutions(),
      ]);
      setRecipes(recipesData);
      setRecentExecutions(executionsData.slice(0, 5));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCloneRecipe = async (recipeId: number) => {
    try {
      const cloned = await api.cloneRecipe(recipeId);
      navigate(`/recipes/${cloned.id}`);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDeleteRecipe = async (recipeId: number) => {
    if (!window.confirm('Are you sure you want to delete this recipe?')) return;
    try {
      await api.deleteRecipe(recipeId);
      setRecipes(recipes.filter(r => r.id !== recipeId));
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  const templateRecipes = recipes.filter(r => r.is_template);
  const userRecipes = recipes.filter(r => !r.is_template);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-secondary-900">{t('dashboardTitle')}</h1>
        <p className="text-secondary-600 mt-1">
          {t('dashboardSubtitle')}
        </p>
      </div>

      {error && (
        <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {/* Templates */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-secondary-900">
              {t('myTemplates')}
            </h2>
            <p className="text-sm text-secondary-500">{t('templatesDescription')}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => navigate('/templates/new')}>
            {t('createNewTemplate')}
          </Button>
        </div>
        {templateRecipes.length === 0 ? (
          <Card>
            <CardBody className="text-center py-8">
              <p className="text-secondary-600 mb-4">
                {t('noTemplatesYet')}
              </p>
              <Button variant="secondary" onClick={() => navigate('/templates/new')}>
                {t('createNewTemplate')}
              </Button>
            </CardBody>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {templateRecipes.map((template) => (
              <TemplateCard
                key={template.id}
                template={template}
                onEdit={() => navigate(`/templates/${template.id}`)}
                onDelete={() => handleDeleteRecipe(template.id)}
                t={t}
              />
            ))}
          </div>
        )}
      </section>

      {/* Recipes */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-secondary-900">
              {t('myRecipes')}
            </h2>
            <p className="text-sm text-secondary-500">{t('recipesDescription')}</p>
          </div>
          <Button size="sm" onClick={() => navigate('/recipes/new')}>
            {t('createNewRecipe')}
          </Button>
        </div>
        {userRecipes.length === 0 ? (
          <Card>
            <CardBody className="text-center py-12">
              <p className="text-secondary-600 mb-4">
                {t('noRecipesYet')}
              </p>
              <Button onClick={() => navigate('/recipes/new')}>
                {t('createFirstRecipe')}
              </Button>
            </CardBody>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {userRecipes.map((recipe) => (
              <RecipeCard
                key={recipe.id}
                recipe={recipe}
                onRun={() => navigate(`/recipes/${recipe.id}/run`)}
                onEdit={() => navigate(`/recipes/${recipe.id}`)}
                onClone={() => handleCloneRecipe(recipe.id)}
                onDelete={() => handleDeleteRecipe(recipe.id)}
                t={t}
              />
            ))}
          </div>
        )}
      </section>

      {/* Recent Executions */}
      <section>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-secondary-900">
            {t('recentExecutions')}
          </h2>
          {recentExecutions.length > 0 && (
            <Button variant="ghost" onClick={() => navigate('/executions')}>
              {t('viewAll')}
            </Button>
          )}
        </div>
        {recentExecutions.length === 0 ? (
          <Card>
            <CardBody className="text-center py-8">
              <p className="text-secondary-600">
                {t('noExecutionsYet')}
              </p>
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-2">
            {recentExecutions.map((execution) => (
              <ExecutionRow
                key={execution.id}
                execution={execution}
                onClick={() => navigate(`/executions/${execution.id}`)}
                t={t}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

interface RecipeCardProps {
  recipe: Recipe;
  onRun?: () => void;
  onEdit?: () => void;
  onClone?: () => void;
  onDelete?: () => void;
  t: (key: any) => string;
}

function RecipeCard({ recipe, onRun, onEdit, onClone, onDelete, t }: RecipeCardProps) {
  const { language } = useLanguage();
  const [translatedName, setTranslatedName] = useState(recipe.name);
  const [translatedDesc, setTranslatedDesc] = useState(recipe.description || '');

  useEffect(() => {
    if (language === 'en') {
      setTranslatedName(recipe.name);
      setTranslatedDesc(recipe.description || '');
    } else {
      translateText(recipe.name, 'en', language).then(setTranslatedName);
      if (recipe.description) {
        translateText(recipe.description, 'en', language).then(setTranslatedDesc);
      }
    }
  }, [recipe.name, recipe.description, language]);

  return (
    <Card hoverable className="flex flex-col">
      <CardBody className="flex-1">
        <div className="flex items-start justify-between">
          <h3 className="font-semibold text-secondary-900">{translatedName}</h3>
          <span className="text-sm text-secondary-500">
            {recipe.step_count || 0} {t('templates')}
          </span>
        </div>
        <p className="text-sm text-secondary-600 mt-2 line-clamp-2">
          {translatedDesc || t('noDescription')}
        </p>
      </CardBody>
      <div className="px-6 py-3 border-t border-secondary-100 flex items-center justify-between">
        {onRun && (
          <Button size="sm" onClick={onRun}>
            {t('run')}
          </Button>
        )}
        <div className="flex items-center space-x-2">
          {onEdit && (
            <Button size="sm" variant="ghost" onClick={onEdit}>
              {t('edit')}
            </Button>
          )}
          {onClone && (
            <Button size="sm" variant="ghost" onClick={onClone}>
              {t('clone')}
            </Button>
          )}
          {onDelete && (
            <Button size="sm" variant="ghost" onClick={onDelete}>
              {t('delete')}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

interface TemplateCardProps {
  template: Recipe;
  onEdit: () => void;
  onDelete: () => void;
  t: (key: any) => string;
}

function TemplateCard({ template, onEdit, onDelete, t }: TemplateCardProps) {
  const { language } = useLanguage();
  const [translatedName, setTranslatedName] = useState(template.name);
  const [translatedDesc, setTranslatedDesc] = useState(template.description || '');
  const [templateType, setTemplateType] = useState<'AI' | 'API'>('AI');

  useEffect(() => {
    if (language === 'en') {
      setTranslatedName(template.name);
      setTranslatedDesc(template.description || '');
    } else {
      translateText(template.name, 'en', language).then(setTranslatedName);
      if (template.description) {
        translateText(template.description, 'en', language).then(setTranslatedDesc);
      }
    }
  }, [template.name, template.description, language]);

  // Determine template type: "API" if any step is scraping, otherwise "AI"
  useEffect(() => {
    if (template.steps && template.steps.length > 0) {
      // Steps are available, check step types
      const hasScrapingStep = template.steps.some(step => step.step_type === 'scraping');
      setTemplateType(hasScrapingStep ? 'API' : 'AI');
    } else {
      // Steps not loaded, fetch full recipe to determine type
      api.getRecipe(template.id).then(fullRecipe => {
        if (fullRecipe.steps && fullRecipe.steps.length > 0) {
          const hasScrapingStep = fullRecipe.steps.some(step => step.step_type === 'scraping');
          setTemplateType(hasScrapingStep ? 'API' : 'AI');
        }
      }).catch(() => {
        // If fetch fails, default to 'AI'
        setTemplateType('AI');
      });
    }
  }, [template.id, template.steps]);

  return (
    <Card hoverable className="flex flex-col" onClick={onEdit}>
      <CardBody className="flex-1">
        <div className="flex items-start justify-between">
          <h3 className="font-semibold text-secondary-900">{translatedName}</h3>
          <span className="inline-block px-2 py-0.5 text-xs font-medium bg-primary-100 text-primary-700 rounded">
            {templateType}
          </span>
        </div>
        <p className="text-sm text-secondary-600 mt-2 line-clamp-2">
          {translatedDesc || t('noDescription')}
        </p>
      </CardBody>
      <div className="px-6 py-3 border-t border-secondary-100 flex items-center justify-end">
        <div className="flex items-center space-x-2">
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onEdit(); }}>
            {t('edit')}
          </Button>
          <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
            {t('delete')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

interface ExecutionRowProps {
  execution: WorkflowExecution;
  onClick: () => void;
  t: (key: any) => string;
}

function ExecutionRow({ execution, onClick, t }: ExecutionRowProps) {
  const { language } = useLanguage();
  const [translatedName, setTranslatedName] = useState(execution.recipe_name || `Recipe #${execution.recipe_id}`);

  useEffect(() => {
    const recipeName = execution.recipe_name || `Recipe #${execution.recipe_id}`;
    if (language === 'en') {
      setTranslatedName(recipeName);
    } else {
      translateText(recipeName, 'en', language).then(setTranslatedName);
    }
  }, [execution.recipe_name, execution.recipe_id, language]);

  const statusColors: Record<string, string> = {
    pending: 'bg-secondary-100 text-secondary-700',
    running: 'bg-blue-100 text-blue-700',
    paused: 'bg-yellow-100 text-yellow-700',
    completed: 'bg-green-100 text-green-700',
    failed: 'bg-red-100 text-red-700',
  };

  const statusLabels: Record<string, string> = {
    pending: t('pending'),
    running: t('running'),
    paused: t('paused'),
    completed: t('completed'),
    failed: t('failed'),
  };

  return (
    <Card hoverable onClick={onClick}>
      <CardBody className="flex items-center justify-between py-3">
        <div className="flex items-center space-x-4">
          <span className={`px-2 py-1 text-xs font-medium rounded ${statusColors[execution.status]}`}>
            {statusLabels[execution.status] || execution.status}
          </span>
          <span className="font-medium text-secondary-900">
            {translatedName}
          </span>
        </div>
        <div className="flex items-center space-x-4 text-sm text-secondary-500">
          <span>
            {t('currentStep')} {execution.current_step}/{execution.total_steps || '?'}
          </span>
          <span>
            {new Date(execution.created_at).toLocaleDateString()}
          </span>
        </div>
      </CardBody>
    </Card>
  );
}
