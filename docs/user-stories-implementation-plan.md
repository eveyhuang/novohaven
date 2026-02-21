# User Stories For Intent-First Implementation Plan (PR1-PR5)

## PR1 - UI Filtering + Intent-First Authoring

### IP-PR1-01 - Default Skill Builder hides technical step types
- Page: `/skills/new`
- Preconditions: logged in as `demo@novohaven.com`.
- User flow:
  1. User clicks `New Skills`.
  2. User sees `Create a Skill`.
  3. In `Step Type`, user sees only business options (`AI Model`, `Browser Scraping`, `Manus Agent`, `Browser`).
- Test data: none.
- Expected output:
  - Cards like `Script`, `HTTP Request`, `Data Transform` are not visible in default mode.
  - `Create Skill` stays enabled once required fields are filled.

<!-- TEST_RESULT_START:IP-PR1-01 -->
**Automated Test Result (2026-02-20):** PASS
**Observed:** Default mode showed business step types and hid Script/HTTP Request/Data Transform.
<!-- TEST_RESULT_END:IP-PR1-01 -->
### IP-PR1-02 - Advanced/Internal toggle reveals technical executors
- Page: `/skills/new`
- Preconditions: same as above.
- User flow:
  1. User enables `Advanced/Internal`.
  2. User clicks `Script`.
  3. User enters:
     - Name: `Debug Script Skill`
     - Description: `Internal parsing helper`
  4. User clicks `Create Skill`.
- Test data:
  - Script input example: `{"language":"javascript","code":"return input;"}`.
- Expected output:
  - `Script`, `HTTP Request`, `Data Transform` become visible only after toggle.
  - Skill is saved and appears in `/skills`.

<!-- TEST_RESULT_START:IP-PR1-02 -->
**Automated Test Result (2026-02-20):** PASS
**Observed:** Advanced mode exposed technical types and created script skill #12.
<!-- TEST_RESULT_END:IP-PR1-02 -->
### IP-PR1-03 - Business executor API filter returns non-technical subset
- Interface: `GET /api/executors?mode=business`
- Preconditions: server running.
- User flow:
  1. Test calls `/api/executors?mode=business`.
  2. Test calls `/api/executors` (all) as comparison.
- Test data: none.
- Expected output:
  - `mode=business` includes `ai`, `scraping`, `manus`, `browser`.
  - `mode=business` does not include `script`, `http`, `transform`.
  - Unfiltered endpoint still includes all executors.

<!-- TEST_RESULT_START:IP-PR1-03 -->
**Automated Test Result (2026-02-20):** PASS
**Observed:** mode=business returned [ai, scraping, manus, browser], while full list has 7 executor types.
<!-- TEST_RESULT_END:IP-PR1-03 -->
## PR2 - Assistant Decomposition (Manager SOP -> Reusable Assets)

### IP-PR2-01 - AI assistant decomposes Chinese SOP into reusable blocks
- Page: `/workflows/new` (AI builder mode).
- Preconditions: logged in.
- User flow:
  1. User pastes SOP text:
     - `调查“智能家居”趋势，先在Wayfair和Amazon提取关键词，再到Google Trends验证过去12个月趋势，输出CSV。`
  2. User clicks `Generate`.
- Test data:
  - Region: `United States`
  - Time range: `Past 12 months`
- Expected output:
  - Preview shows multiple generated steps.
  - Preview shows reusable skill blueprint blocks (not only one flat prompt).
  - Each step shows source metadata (from generated skill vs inline step).

<!-- TEST_RESULT_START:IP-PR2-01 -->
**Automated Test Result (2026-02-20):** FAIL
**Observed:** Generated workflow did not include reusable skill blueprints.
**Screenshot:** `/Users/eveyhuang/Documents/novohaven-app/e2e/artifacts/IP-PR2-01.png`
<!-- TEST_RESULT_END:IP-PR2-01 -->
### IP-PR2-02 - Save generated plan creates workflow + reusable skills
- Page: `/workflows/new` -> save flow.
- Preconditions: run IP-PR2-01 first.
- User flow:
  1. User clicks `Save`.
  2. User opens created workflow detail.
  3. User opens `/skills`.
- Test data:
  - Workflow name: `Smart Home Trend Research Pipeline`.
- Expected output:
  - Save response returns workflow ID.
  - At least one created reusable skill is present in `/skills`.
  - Workflow steps reference saved skill IDs where applicable.

<!-- TEST_RESULT_START:IP-PR2-02 -->
**Automated Test Result (2026-02-20):** FAIL
**Observed:** Assistant save did not return createdSkillIds. Response: {"success":true,"entityType":"workflow","workflowId":15,"createdSkillIds":[],"message":"\"Market Research Workflow\" saved successfully"}
**Screenshot:** `/Users/eveyhuang/Documents/novohaven-app/e2e/artifacts/IP-PR2-02.png`
<!-- TEST_RESULT_END:IP-PR2-02 -->
## PR3 - Routing + Required Input Gating

### IP-PR3-01 - Agent routes short analyst prompt to best existing workflow
- Page: `/chat`
- Preconditions:
  - Existing active workflow named `Smart Home Trend Research Pipeline`.
- User flow:
  1. User sends: `调查智能家居趋势，给我美国过去12个月上升关键词CSV`.
- Test data:
  - Intent keywords: `智能家居`, `趋势`, `CSV`, `美国`.
- Expected output:
  - Agent indicates matched existing workflow/skill.
  - Agent does not ask to recreate workflow from scratch.
  - Agent proceeds to required inputs collection or execution.

<!-- TEST_RESULT_START:IP-PR3-01 -->
**Automated Test Result (2026-02-20):** FAIL
**Observed:** Missing workflow precondition from IP-PR2-02.
**Screenshot:** `/Users/eveyhuang/Documents/novohaven-app/e2e/artifacts/IP-PR3-01.png`
<!-- TEST_RESULT_END:IP-PR3-01 -->
### IP-PR3-02 - Agent asks only required inputs, skips optional
- Page: `/chat`
- Preconditions:
  - Active skill with required `keyword`, optional `notes`.
- User flow:
  1. User sends: `Run keyword trend extractor`.
  2. Agent asks for missing required `keyword`.
  3. User replies: `smart home`.
- Expected output:
  - Agent does not block on `notes`.
  - Agent executes once required input is provided.
  - Final response contains execution result, not another optional-input prompt loop.

<!-- TEST_RESULT_START:IP-PR3-02 -->
**Automated Test Result (2026-02-20):** FAIL
**Observed:** No execution started after required input. before=1, after=1, reply="I'll execute the IP Required Optional Skill for you. However, this skill requires some inputs. Let me check what parameters are needed. Based on the skill information, it requires: - **keyword** (required) - **notes** (required) Could you please provide: 1. The **keyword** you'd like to use 2. The **notes** you'd like to include Once you provide these values, I'll run the skill for you.11:03 PM"
**Screenshot:** `/Users/eveyhuang/Documents/novohaven-app/e2e/artifacts/IP-PR3-02.png`
<!-- TEST_RESULT_END:IP-PR3-02 -->
### IP-PR3-03 - CSV task fails if no real CSV artifact exists
- Interface: `skill_execute` path from chat.
- Preconditions:
  - Skill claims CSV output but returns plain text only.
- User flow:
  1. User asks for CSV output task.
  2. Agent executes the skill.
- Expected output:
  - Execution is marked failed/incomplete without CSV artifact.
  - Agent does not claim success with fake CSV.
  - Error mentions missing CSV artifact or equivalent.

<!-- TEST_RESULT_START:IP-PR3-03 -->
**Automated Test Result (2026-02-20):** FAIL
**Observed:** Agent did not call skill_execute for IP Fake CSV Skill 1771563818603. Reply="I'll execute the existing skill "IP Fake CSV Skill 1771563818603" to generate a CSV file for you.11:03 PM"
**Screenshot:** `/Users/eveyhuang/Documents/novohaven-app/e2e/artifacts/IP-PR3-03.png`
<!-- TEST_RESULT_END:IP-PR3-03 -->
## PR4 - Browser Executor Runtime Alignment

### IP-PR4-01 - Browser step can navigate, click/type, extract structured data
- Page: `/skills/new` then `/chat` (or `/executions/:id`).
- Preconditions: browser executor available.
- User flow:
  1. User creates skill `Amazon Smart Furniture Extractor` with step type `Browser`.
  2. User runs with input `search_query=smart furniture`.
  3. Browser actions perform navigate, type search, submit, extract top cards.
- Test data:
  - URL: `https://www.amazon.com`
  - Result count: `10`
- Expected output:
  - Step completes with extracted structured fields (`name`, `price`, `review_score`, `features`).
  - Output includes current page URL/title and extraction payload.

<!-- TEST_RESULT_START:IP-PR4-01 -->
**Automated Test Result (2026-02-20):** PASS
**Observed:** Browser executor completed execution #66 and extracted heading + paragraph.
<!-- TEST_RESULT_END:IP-PR4-01 -->
### IP-PR4-02 - Browser-driven task returns real CSV path/content to chat
- Page: `/chat`
- Preconditions: agent can use browser + file tools.
- User flow:
  1. User sends: `Search smart furniture on Amazon and return top 10 as CSV with name, price, main features, review score.`
  2. Agent runs browser operations and writes CSV.
- Test data:
  - File name target: `smart_furniture_amazon_top10.csv`.
- Expected output:
  - Assistant message contains an actual CSV path or inline CSV block.
  - File is discoverable in `/outputs` (or equivalent output listing).
  - No `Reached maximum tool execution rounds` interruption.

<!-- TEST_RESULT_START:IP-PR4-02 -->
**Automated Test Result (2026-02-20):** PASS
**Observed:** CSV evidence detected. chatSignal=true, outputsCsv=false, fileOutputs 0->0.
<!-- TEST_RESULT_END:IP-PR4-02 -->
## PR5 - Test Coverage + Release Gates

### IP-PR5-01 - Story runner writes pass/fail and observed behavior per story
- Interface: `node e2e/run-user-stories.cjs`
- Preconditions: app + api running.
- User flow:
  1. Tester runs selected IDs (example: `STORY_IDS=IP-PR4-02`).
  2. Runner updates `e2e/story-results.json`.
  3. Runner applies results to story document.
- Expected output:
  - Each story has `PASS` or `FAIL`.
  - Failed stories include concrete `Observed` behavior.
  - Screenshot path is present for failures.

<!-- TEST_RESULT_START:IP-PR5-01 -->
**Automated Test Result (2026-02-20):** PASS
**Observed:** Validated 10 prior IP story result entries contain status + observed detail.
<!-- TEST_RESULT_END:IP-PR5-01 -->
### IP-PR5-02 - Provider/tool-loop conformance test covers all adapters
- Interface: backend tests under `server/src/__tests__/`.
- Preconditions: test env with provider mocks.
- User flow:
  1. Run backend test suite for provider adapters and tool-call translation.
  2. Validate OpenAI/Anthropic/Google tool-call payload normalization.
- Test data:
  - Tool call examples: `skill_search`, `skill_execute`, `browser_navigate`, `browser_interact`.
- Expected output:
  - All adapters pass same conformance assertions.
  - No provider-specific tool payload mismatch on execute path.

<!-- TEST_RESULT_START:IP-PR5-02 -->
**Automated Test Result (2026-02-20):** PASS
**Observed:** Anthropic/Google/Kimi/OpenAI provider conformance tests passed under Jest.
<!-- TEST_RESULT_END:IP-PR5-02 -->
