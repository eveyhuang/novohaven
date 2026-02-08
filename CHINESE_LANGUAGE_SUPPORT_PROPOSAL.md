# Chinese Language Support for AI Prompts and Outputs

## Problem Statement
When users switch to Chinese language, they want to:
1. View and edit AI prompts in Chinese
2. Receive AI outputs in Chinese
3. Maintain consistency across the application

## Proposed Approaches

### Approach 1: **Language Instruction Injection** (Recommended)
**How it works:**
- Add a language instruction to prompts automatically when language is Chinese
- Store prompts in their original language (English or Chinese)
- Inject "Please respond in Chinese" or "请用中文回答" at the end of prompts before sending to AI

**Pros:**
- ✅ Simple to implement
- ✅ No translation overhead
- ✅ Users can write prompts in either language
- ✅ Preserves original prompt structure
- ✅ Works with existing AI models
- ✅ No data duplication

**Cons:**
- ⚠️ Requires AI models to understand Chinese (most modern models do)
- ⚠️ May not translate existing English prompts automatically

**Implementation:**
- Add language context to `LanguageContext`
- Modify prompt compilation in `workflowEngine.ts` and `testAI` calls
- Add language instruction suffix when `language === 'zh'`

---

### Approach 2: **Automatic Prompt Translation**
**How it works:**
- Automatically translate prompts from English to Chinese when language is set to Chinese
- Translate outputs back to Chinese if needed
- Store original English prompts, display translated versions

**Pros:**
- ✅ Seamless user experience
- ✅ Existing English prompts automatically work in Chinese
- ✅ Users see everything in their preferred language

**Cons:**
- ❌ Translation quality may vary
- ❌ May lose nuance in technical prompts
- ❌ Additional API calls for translation
- ❌ Potential latency
- ❌ Cost of translation API
- ❌ Variable names might get translated incorrectly

**Implementation:**
- Use existing `translationService.ts`
- Translate prompts on-the-fly when displaying/editing
- Cache translations to avoid repeated calls

---

### Approach 3: **Bilingual Template Storage**
**How it works:**
- Store prompts in both English and Chinese
- Allow users to edit in their preferred language
- Switch between languages seamlessly

**Pros:**
- ✅ Best quality (human-editable translations)
- ✅ No translation overhead at runtime
- ✅ Users can customize translations
- ✅ Preserves technical accuracy

**Cons:**
- ❌ Requires database schema changes
- ❌ More storage space
- ❌ Users need to maintain both versions
- ❌ Migration needed for existing templates
- ❌ More complex UI

**Implementation:**
- Add `prompt_template_zh` column to database
- Update template editor to show language-specific prompts
- Add language toggle in template editor

---

### Approach 4: **Hybrid: Language Instruction + Optional Translation**
**How it works:**
- Default: Use language instruction injection (Approach 1)
- Optional: Allow users to manually translate prompts
- Store both versions if user provides translation

**Pros:**
- ✅ Best of both worlds
- ✅ Simple default behavior
- ✅ Advanced users can provide better translations
- ✅ Backward compatible

**Cons:**
- ⚠️ More complex implementation
- ⚠️ Requires UI for translation management

---

## Recommended Implementation: Approach 1 + Approach 4 Hybrid

### Phase 1: Language Instruction Injection (Quick Win)
1. Add language detection to prompt compilation
2. Inject language instruction when `language === 'zh'`
3. Update `workflowEngine.ts` server-side
4. Update `testAI` calls client-side

### Phase 2: Optional Manual Translation (Future Enhancement)
1. Add `prompt_template_zh` field to database
2. Add translation UI in template editor
3. Use Chinese version if available, otherwise use language instruction

---

## Implementation Details

### Server-Side Changes (`workflowEngine.ts`)
```typescript
// When compiling prompts, add language instruction
function compilePrompt(template: string, variables: Record<string, any>, language: Language): string {
  let prompt = replaceVariables(template, variables);
  
  if (language === 'zh') {
    prompt += '\n\n请用中文回答。';
  }
  
  return prompt;
}
```

### Client-Side Changes (`TemplateEditor.tsx`)
```typescript
// Show language indicator
{language === 'zh' && (
  <div className="text-sm text-blue-600">
    💡 AI将用中文回答
  </div>
)}
```

### API Changes
- Add `language` parameter to execution requests
- Pass language context through to AI calls

---

## User Experience Flow

1. User switches language to Chinese
2. Template editor shows existing prompts (English or Chinese)
3. User can edit prompts in Chinese
4. When running workflow:
   - If prompt is in English → Add "Please respond in Chinese"
   - If prompt is in Chinese → Use as-is
5. AI responds in Chinese
6. Outputs displayed in Chinese

---

## Migration Strategy

1. **No breaking changes** - existing templates work as-is
2. **Gradual enhancement** - users can start using Chinese prompts immediately
3. **Backward compatible** - English prompts still work with language instruction
